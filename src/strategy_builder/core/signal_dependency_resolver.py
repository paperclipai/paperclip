"""
Signal Dependency Resolver
Manages signal dependencies and timing constraint validation
Reference: docs/v3/UI-UX/07_TIMING_CONSTRAINTS.md
"""

from typing import List, Dict, Optional, Set
from dataclasses import dataclass, field

from src.strategy_builder.core.strategy_config_engine import (
    StrategyConfig,
    BlockConfig,
    SignalConfig,
    TimingConstraint
)


class TimingViolation(Exception):
    """Exception raised when timing constraint is violated"""
    
    def __init__(self, signal: str, reference: str, max_candles: int, actual_candles: int):
        self.signal = signal
        self.reference = reference
        self.max_candles = max_candles
        self.actual_candles = actual_candles
        message = (
            f"Timing violation: {signal} must fire within {max_candles} candles "
            f"of {reference}, but {actual_candles} candles have passed"
        )
        super().__init__(message)


@dataclass
class SignalNode:
    """Node in dependency graph representing a signal"""
    block_name: str
    signal_name: str
    logic: str  # "AND" or "OR"
    timing_constraint: Optional[TimingConstraint] = None
    
    @property
    def full_name(self) -> str:
        """Get full name (block.signal)"""
        return f"{self.block_name}.{self.signal_name}"


@dataclass
class ExitConditionNode:
    """
    Node for exit condition in dependency graph
    Sprint 1.8 Task 1.8.39
    
    Exit conditions should NOT cause circular dependency errors
    when they reference entry signals (exits naturally depend on entries)
    """
    signal_name: str
    exit_mode: str  # "ABSOLUTE" or "FLEXIBLE"
    binding_level: str  # "STRATEGY", "BLOCK", "SIGNAL"
    timing_constraint: Optional[TimingConstraint] = None
    is_exit: bool = True  # Distinguishes from entry signals
    
    @property
    def full_name(self) -> str:
        """Get full name (EXIT:signal_name)"""
        return f"EXIT:{self.signal_name}"


@dataclass
class DependencyGraph:
    """Graph structure for signal dependencies"""
    nodes: List[SignalNode] = field(default_factory=list)
    edges: List[tuple] = field(default_factory=list)  # (from_signal, to_signal, constraint)
    
    def add_node(self, node: SignalNode):
        """Add node to graph"""
        self.nodes.append(node)
        
    def add_edge(self, from_signal: str, to_signal: str, constraint: Optional[TimingConstraint] = None):
        """Add dependency edge"""
        self.edges.append((from_signal, to_signal, constraint))
        
    def get_node(self, full_name: str) -> Optional[SignalNode]:
        """Get node by full name"""
        for node in self.nodes:
            if node.full_name == full_name:
                return node
        return None
        
    def get_dependencies(self, signal_name: str) -> List[str]:
        """Get list of signals this signal depends on"""
        deps = []
        for from_sig, to_sig, _ in self.edges:
            if from_sig == signal_name:
                deps.append(to_sig)
        return deps
        
    def has_circular_dependency(self) -> bool:
        """Check for circular dependencies using DFS"""
        visited = set()
        rec_stack = set()
        
        def has_cycle(signal: str) -> bool:
            visited.add(signal)
            rec_stack.add(signal)
            
            # Check all dependencies
            for dep in self.get_dependencies(signal):
                if dep not in visited:
                    if has_cycle(dep):
                        return True
                elif dep in rec_stack:
                    return True
                    
            rec_stack.remove(signal)
            return False
        
        # Check each node
        for node in self.nodes:
            if node.full_name not in visited:
                if has_cycle(node.full_name):
                    return True
                    
        return False


class SignalDependencyResolver:
    """
    Resolves signal dependencies and validates timing constraints
    Manages the cascade reset logic when timing windows are exceeded
    """
    
    def __init__(self):
        """Initialize resolver"""
        pass
        
    def build_graph(self, config: StrategyConfig) -> DependencyGraph:
        """
        Build dependency graph from strategy configuration
        
        Args:
            config: Strategy configuration
            
        Returns:
            DependencyGraph with nodes and edges
            
        Raises:
            ValueError: If circular dependencies detected
        """
        graph = DependencyGraph()
        
        # Add all signals as nodes
        for block in config.blocks:
            for signal in block.signals:
                node = SignalNode(
                    block_name=block.name,
                    signal_name=signal.name,
                    logic=signal.logic,
                    timing_constraint=signal.timing_constraint
                )
                graph.add_node(node)
                
        # Add edges for timing constraints
        for block in config.blocks:
            for signal in block.signals:
                if signal.timing_constraint:
                    # Find reference signal
                    reference = signal.timing_constraint.reference
                    from_signal_name = f"{block.name}.{signal.name}"
                    
                    # Find the referenced signal in same or previous blocks
                    for ref_block in config.blocks:
                        for ref_signal in ref_block.signals:
                            if (ref_signal.name in reference or 
                                reference in ref_signal.name or
                                reference == "any previous signal"):
                                to_signal_name = f"{ref_block.name}.{ref_signal.name}"
                                graph.add_edge(
                                    from_signal=from_signal_name,
                                    to_signal=to_signal_name,
                                    constraint=signal.timing_constraint
                                )
                                break
                        else:
                            continue
                        break
        
        # Check for circular dependencies
        if graph.has_circular_dependency():
            raise ValueError("Circular dependencies detected in signal timing constraints")
            
        return graph
        
    def validate_timing(
        self,
        signal: SignalConfig,
        fired_at_candle: int,
        current_candle: int,
        reference_candle: Optional[int] = None
    ) -> bool:
        """
        Validate timing constraint for a signal
        
        Args:
            signal: Signal configuration
            fired_at_candle: Candle where signal fired
            current_candle: Current candle number
            reference_candle: Candle where reference signal fired
            
        Returns:
            True if timing is valid, False otherwise
        """
        # No constraint = always valid
        if not signal.timing_constraint:
            return True
            
        # No reference candle provided = can't validate
        if reference_candle is None:
            return True
            
        # Check if signal fired within window
        candles_since_reference = fired_at_candle - reference_candle
        max_candles = signal.timing_constraint.max_candles
        
        return candles_since_reference <= max_candles
        
    def should_reset_strategy(
        self,
        config: StrategyConfig,
        graph: DependencyGraph,
        signal_state: Dict[str, int],  # signal_name -> candle_fired
        current_candle: int
    ) -> bool:
        """
        Determine if strategy should reset due to timing violations
        
        Args:
            config: Strategy configuration
            graph: Dependency graph
            signal_state: Current state of fired signals
            current_candle: Current candle number
            
        Returns:
            True if strategy should reset, False otherwise
        """
        # Check each unfired signal with timing constraints
        for block in config.blocks:
            for signal in block.signals:
                full_name = f"{block.name}.{signal.name}"
                
                # Skip if signal already fired
                if full_name in signal_state:
                    continue
                    
                # Check timing constraint
                if signal.timing_constraint:
                    reference = signal.timing_constraint.reference
                    max_candles = signal.timing_constraint.max_candles
                    
                    # Find reference signal candle
                    reference_candle = None
                    for ref_block in config.blocks:
                        for ref_signal in ref_block.signals:
                            ref_full_name = f"{ref_block.name}.{ref_signal.name}"
                            if ref_full_name in signal_state:
                                if (ref_signal.name in reference or
                                    reference in ref_signal.name):
                                    reference_candle = signal_state[ref_full_name]
                                    break
                        if reference_candle is not None:
                            break
                    
                    # If reference fired and we're past window, reset
                    if reference_candle is not None:
                        candles_passed = current_candle - reference_candle
                        if candles_passed > max_candles:
                            return True
                            
        return False
        
    def get_dependencies(self, graph: DependencyGraph, signal_name: str) -> List[str]:
        """
        Get list of signals that a given signal depends on
        
        Args:
            graph: Dependency graph
            signal_name: Full signal name (block.signal)
            
        Returns:
            List of dependency signal names
        """
        return graph.get_dependencies(signal_name)
        
    def get_timing_window(
        self,
        signal: SignalConfig,
        signal_state: Dict[str, int],
        current_candle: int
    ) -> Optional[int]:
        """
        Get remaining candles in timing window
        
        Args:
            signal: Signal configuration
            signal_state: Current signal state
            current_candle: Current candle
            
        Returns:
            Remaining candles in window, or None if no constraint
        """
        if not signal.timing_constraint:
            return None
            
        reference = signal.timing_constraint.reference
        max_candles = signal.timing_constraint.max_candles
        
        # Find reference candle
        reference_candle = None
        for sig_name, candle in signal_state.items():
            if reference in sig_name:
                reference_candle = candle
                break
                
        if reference_candle is None:
            return max_candles  # Full window available
            
        elapsed = current_candle - reference_candle
        remaining = max_candles - elapsed
        return max(0, remaining)
        
    def validate_all_constraints(
        self,
        config: StrategyConfig,
        graph: DependencyGraph,
        signal_state: Dict[str, int]
    ) -> tuple[bool, List[str]]:
        """
        Validate all timing constraints in strategy
        
        Args:
            config: Strategy configuration
            graph: Dependency graph
            signal_state: Current signal state
            
        Returns:
            Tuple of (valid, list of error messages)
        """
        errors = []
        
        for block in config.blocks:
            for signal in block.signals:
                full_name = f"{block.name}.{signal.name}"
                
                if full_name not in signal_state:
                    continue
                    
                if signal.timing_constraint:
                    # Find reference
                    reference = signal.timing_constraint.reference
                    reference_candle = None
                    
                    for ref_name, candle in signal_state.items():
                        if reference in ref_name:
                            reference_candle = candle
                            break
                            
                    if reference_candle is not None:
                        fired_at = signal_state[full_name]
                        if not self.validate_timing(
                            signal,
                            fired_at,
                            fired_at,
                            reference_candle
                        ):
                            errors.append(
                                f"Timing violation: {full_name} fired outside window "
                                f"(max {signal.timing_constraint.max_candles} candles)"
                            )
                            
        return len(errors) == 0, errors
