"""
Optimizer V3 - Dependency Graph
Analyzes strategy dependencies, identifies anchors, and detects cycles.
"""

from typing import Dict, List, Set, Any, Optional, Tuple
from collections import defaultdict, deque

from src.optimizer_v3.core.logger import OptimizerLogger
from src.optimizer_v3.core.validator import DataValidator, ValidationError

import logging
logger = logging.getLogger(__name__)



class DependencyGraph:
    """
    Build and analyze dependency graphs for trading strategies.
    
    Features:
    - Parse strategy building blocks
    - Identify anchor blocks (no dependencies)
    - Build dependency relationships
    - Detect circular dependencies
    - Generate execution order
    - Validate graph integrity
    
    Args:
        logger: OptimizerLogger instance for logging
        validator: DataValidator instance for validation
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        validator: Optional[DataValidator] = None
    ):
        self.logger = logger
        self.validator = validator or DataValidator(logger)
        
        # Graph structure
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.edges: Dict[str, List[str]] = defaultdict(list)
        self.reverse_edges: Dict[str, List[str]] = defaultdict(list)
        
        # Analysis results
        self.anchors: List[str] = []
        self.execution_order: List[str] = []
        self.has_cycles: bool = False
        self.cycles: List[List[str]] = []
    
    def build_from_strategy(self, strategy: Dict[str, Any]) -> None:
        """
        Build dependency graph from strategy configuration.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Raises:
            ValidationError: If strategy is invalid
        """
        self.logger.info(
            "Building dependency graph",
            strategy_name=strategy.get('name', 'unknown')
        )
        
        # Validate strategy first
        self.validator.validate_strategy(strategy)
        
        # Clear existing graph
        self.clear()
        
        # Extract blocks
        blocks = strategy.get('blocks', [])
        
        # Build nodes
        for block in blocks:
            self._add_block(block)
        
        # Build edges (dependencies)
        for block in blocks:
            self._add_dependencies(block)
        
        # Analyze graph
        self._identify_anchors()
        self._detect_cycles()
        self._generate_execution_order()
        
        self.logger.info(
            "Dependency graph built",
            num_nodes=len(self.nodes),
            num_edges=sum(len(deps) for deps in self.edges.values()),
            num_anchors=len(self.anchors),
            has_cycles=self.has_cycles
        )
    
    def _add_block(self, block: Dict[str, Any]) -> None:
        """
        Add a building block as a node in the graph.
        
        Args:
            block: Block configuration dictionary
        """
        block_name = block['name']
        
        if block_name in self.nodes:
            self.logger.warning(
                f"Duplicate block name: {block_name}",
                action="overwriting"
            )
        
        self.nodes[block_name] = {
            'name': block_name,
            'signals': block.get('signals', []),
            'timing_constraint': block.get('timing_constraint'),
            'recheck': block.get('recheck'),
            'required': block.get('required', True),
            'logic': block.get('logic', 'AND')
        }
        
        self.logger.debug(
            f"Added block node: {block_name}",
            num_signals=len(block.get('signals', []))
        )
    
    def _add_dependencies(self, block: Dict[str, Any]) -> None:
        """
        Add dependencies for a building block.
        
        Args:
            block: Block configuration dictionary
        """
        block_name = block['name']
        dependencies = block.get('depends_on', [])
        
        if not dependencies:
            return
        
        for dep in dependencies:
            if dep not in self.nodes:
                self.logger.warning(
                    f"Dependency '{dep}' not found for block '{block_name}'",
                    action="skipping"
                )
                continue
            
            # Add forward edge
            self.edges[block_name].append(dep)
            
            # Add reverse edge for traversal
            self.reverse_edges[dep].append(block_name)
            
            self.logger.debug(
                f"Added dependency: {block_name} -> {dep}"
            )
    
    def _identify_anchors(self) -> None:
        """
        Identify anchor blocks (blocks with no dependencies).
        
        Anchors are blocks that can be evaluated first in the
        execution order.
        """
        self.anchors = []
        
        for node_name in self.nodes:
            if not self.edges[node_name]:
                self.anchors.append(node_name)
        
        self.logger.debug(
            "Identified anchors",
            anchors=self.anchors,
            count=len(self.anchors)
        )
    
    def _detect_cycles(self) -> None:
        """
        Detect circular dependencies in the graph using DFS.
        
        Sets:
            self.has_cycles: True if cycles found
            self.cycles: List of cycles (each cycle is a list of node names)
        """
        self.has_cycles = False
        self.cycles = []
        
        # Track visit state: 0=unvisited, 1=visiting, 2=visited
        state = {node: 0 for node in self.nodes}
        path = []
        
        def dfs(node: str) -> bool:
            """DFS helper to detect cycles"""
            if state[node] == 1:
                # Found a cycle
                cycle_start = path.index(node)
                cycle = path[cycle_start:] + [node]
                self.cycles.append(cycle)
                return True
            
            if state[node] == 2:
                # Already processed
                return False
            
            # Mark as visiting
            state[node] = 1
            path.append(node)
            
            # Visit dependencies
            found_cycle = False
            for dep in self.edges[node]:
                if dfs(dep):
                    found_cycle = True
            
            # Mark as visited
            path.pop()
            state[node] = 2
            
            return found_cycle
        
        # Check all nodes
        for node in self.nodes:
            if state[node] == 0:
                if dfs(node):
                    self.has_cycles = True
        
        if self.has_cycles:
            self.logger.error(
                "Circular dependencies detected",
                num_cycles=len(self.cycles),
                cycles=self.cycles
            )
        else:
            self.logger.debug("No circular dependencies detected")
    
    def _generate_execution_order(self) -> None:
        """
        Generate topological sort for execution order.
        
        Uses Kahn's algorithm for topological sorting.
        If cycles exist, execution order will be partial.
        """
        # Calculate in-degrees
        in_degree = {node: 0 for node in self.nodes}
        for node in self.nodes:
            for dep in self.edges[node]:
                in_degree[dep] += 1
        
        # Queue for nodes with no dependencies
        queue = deque([node for node in self.nodes if in_degree[node] == 0])
        
        # Build execution order
        self.execution_order = []
        
        while queue:
            node = queue.popleft()
            self.execution_order.append(node)
            
            # Reduce in-degree for dependent nodes
            for dependent in self.reverse_edges[node]:
                in_degree[dependent] -= 1
                if in_degree[dependent] == 0:
                    queue.append(dependent)
        
        # Check if all nodes were processed
        if len(self.execution_order) != len(self.nodes):
            self.logger.warning(
                "Incomplete execution order",
                processed=len(self.execution_order),
                total=len(self.nodes),
                reason="likely due to cycles"
            )
        else:
            self.logger.debug(
                "Execution order generated",
                order=self.execution_order
            )
    
    def get_dependencies(self, block_name: str) -> List[str]:
        """
        Get direct dependencies for a block.
        
        Args:
            block_name: Name of the block
            
        Returns:
            List of dependency names
        """
        return self.edges.get(block_name, [])
    
    def get_dependents(self, block_name: str) -> List[str]:
        """
        Get blocks that depend on this block.
        
        Args:
            block_name: Name of the block
            
        Returns:
            List of dependent block names
        """
        return self.reverse_edges.get(block_name, [])
    
    def get_all_dependencies(self, block_name: str) -> Set[str]:
        """
        Get all transitive dependencies for a block.
        
        Args:
            block_name: Name of the block
            
        Returns:
            Set of all dependency names (direct and transitive)
        """
        all_deps = set()
        queue = deque([block_name])
        visited = {block_name}
        
        while queue:
            node = queue.popleft()
            deps = self.edges.get(node, [])
            
            for dep in deps:
                if dep not in visited:
                    all_deps.add(dep)
                    visited.add(dep)
                    queue.append(dep)
        
        return all_deps
    
    def is_valid(self) -> bool:
        """
        Check if graph is valid (no cycles).
        
        Returns:
            True if valid, False if cycles detected
        """
        return not self.has_cycles
    
    def get_execution_order(self) -> List[str]:
        """
        Get the execution order for blocks.
        
        Returns:
            List of block names in execution order
        """
        return self.execution_order.copy()
    
    def get_anchors(self) -> List[str]:
        """
        Get anchor blocks (no dependencies).
        
        Returns:
            List of anchor block names
        """
        return self.anchors.copy()
    
    def get_node_info(self, block_name: str) -> Optional[Dict[str, Any]]:
        """
        Get information about a specific node.
        
        Args:
            block_name: Name of the block
            
        Returns:
            Node information dictionary or None if not found
        """
        return self.nodes.get(block_name)
    
    def get_graph_stats(self) -> Dict[str, Any]:
        """
        Get statistics about the dependency graph.
        
        Returns:
            Dictionary with graph statistics
        """
        return {
            'num_nodes': len(self.nodes),
            'num_edges': sum(len(deps) for deps in self.edges.values()),
            'num_anchors': len(self.anchors),
            'has_cycles': self.has_cycles,
            'num_cycles': len(self.cycles),
            'execution_order_complete': len(self.execution_order) == len(self.nodes)
        }
    
    def clear(self) -> None:
        """Clear all graph data."""
        self.nodes.clear()
        self.edges.clear()
        self.reverse_edges.clear()
        self.anchors.clear()
        self.execution_order.clear()
        self.has_cycles = False
        self.cycles.clear()
        
        self.logger.debug("Dependency graph cleared")
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Export graph as dictionary.
        
        Returns:
            Dictionary representation of the graph
        """
        return {
            'nodes': self.nodes.copy(),
            'edges': dict(self.edges),
            'anchors': self.anchors.copy(),
            'execution_order': self.execution_order.copy(),
            'has_cycles': self.has_cycles,
            'cycles': self.cycles.copy(),
            'stats': self.get_graph_stats()
        }
