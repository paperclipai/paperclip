"""
Registry Interface
Interface layer between Strategy Builder and Block Registry
Reference: docs/v3/UI-UX/10_BLOCK_SEARCH_FILTER.md
"""

from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field


@dataclass
class SignalInfo:
    """Information about a signal within a block"""
    name: str
    count: int
    percentage: float
    description: str = ""
    ui_visible: bool = True  # Default to visible unless explicitly hidden


@dataclass
class BlockInfo:
    """Complete information about a building block"""
    name: str
    category: str
    block_type: str
    default_weight: int
    description: str
    signals: List[SignalInfo] = field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class SearchResult:
    """Result from block search"""
    block_name: str
    category: str
    block_type: str
    match_type: str  # "block_name", "signal_name", "description"
    match_text: str
    relevance_score: float
    signals: List[SignalInfo] = field(default_factory=list)


@dataclass
class SearchFilters:
    """Filters for block search"""
    categories: List[str] = field(default_factory=list)
    block_types: List[str] = field(default_factory=list)
    min_weight: Optional[int] = None
    max_weight: Optional[int] = None


class RegistryInterface:
    """
    Interface layer for accessing Block Registry
    Provides clean API for Strategy Builder to query blocks and signals
    """
    
    def __init__(self, registry):
        """
        Initialize interface with registry
        
        Args:
            registry: BlockRegistry instance
        """
        self.registry = registry
        
    def get_all_blocks(self) -> List[BlockInfo]:
        """
        Get all available blocks from registry
        
        Returns:
            List of BlockInfo objects
        """
        blocks = []
        
        # Get blocks from registry
        raw_blocks = self.registry.get_all_blocks()
        
        for raw_block in raw_blocks:
            # Convert signals
            signals = []
            for raw_signal in raw_block.get('signals', []):
                signal = SignalInfo(
                    name=raw_signal['name'],
                    count=raw_signal.get('count', 0),
                    percentage=raw_signal.get('percentage', 0.0),
                    description=raw_signal.get('description', ''),
                    ui_visible=raw_signal.get('ui_visible', True)  # Extract from registry
                )
                signals.append(signal)
            
            # Create BlockInfo
            block = BlockInfo(
                name=raw_block['name'],
                category=raw_block.get('category', 'UNKNOWN'),
                block_type=raw_block.get('type', 'UNKNOWN'),
                default_weight=raw_block.get('weight', 0),
                description=raw_block.get('description', ''),
                signals=signals,
                metadata=raw_block.get('metadata')
            )
            blocks.append(block)
            
        return blocks
        
    def get_block(self, name: str) -> Optional[BlockInfo]:
        """
        Get specific block by name
        
        Args:
            name: Block name
            
        Returns:
            BlockInfo or None if not found
        """
        raw_block = self.registry.get_block(name)
        
        if raw_block is None:
            return None
            
        # Convert signals
        signals = []
        for raw_signal in raw_block.get('signals', []):
            signal = SignalInfo(
                name=raw_signal['name'],
                count=raw_signal.get('count', 0),
                percentage=raw_signal.get('percentage', 0.0),
                description=raw_signal.get('description', ''),
                ui_visible=raw_signal.get('ui_visible', True)  # Extract from registry
            )
            signals.append(signal)
        
        # Create BlockInfo
        block = BlockInfo(
            name=raw_block['name'],
            category=raw_block.get('category', 'UNKNOWN'),
            block_type=raw_block.get('type', 'UNKNOWN'),
            default_weight=raw_block.get('weight', 0),
            description=raw_block.get('description', ''),
            signals=signals,
            metadata=raw_block.get('metadata')
        )
        
        return block
        
    def get_block_signals(self, block_name: str) -> List[SignalInfo]:
        """
        Get all signals for a specific block
        
        Args:
            block_name: Name of block
            
        Returns:
            List of SignalInfo objects
        """
        block = self.get_block(block_name)
        if block is None:
            return []
        return block.signals
        
    def get_signal_statistics(self, block_name: str, signal_name: str) -> Optional[Dict[str, Any]]:
        """
        Get statistics for a specific signal
        
        Args:
            block_name: Name of block
            signal_name: Name of signal
            
        Returns:
            Dictionary with statistics or None if not found
        """
        block = self.get_block(block_name)
        if block is None:
            return None
            
        for signal in block.signals:
            if signal.name == signal_name:
                return {
                    'total_count': signal.count,
                    'percentage': signal.percentage,
                    'description': signal.description
                }
                
        return None
        
    def search_blocks(
        self,
        query: str = "",
        filters: Optional[SearchFilters] = None
    ) -> List[SearchResult]:
        """
        Search for blocks matching query and filters
        
        Args:
            query: Search query string
            filters: Optional search filters
            
        Returns:
            List of SearchResult objects, sorted by relevance
        """
        results = []
        all_blocks = self.get_all_blocks()
        
        for block in all_blocks:
            # Apply filters first
            if filters:
                if filters.categories and block.category not in filters.categories:
                    continue
                if filters.block_types and block.block_type not in filters.block_types:
                    continue
                if filters.min_weight and block.default_weight < filters.min_weight:
                    continue
                if filters.max_weight and block.default_weight > filters.max_weight:
                    continue
            
            # If no query, include all filtered blocks
            if not query:
                result = SearchResult(
                    block_name=block.name,
                    category=block.category,
                    block_type=block.block_type,
                    match_type="all",
                    match_text=block.name,
                    relevance_score=1.0,
                    signals=block.signals
                )
                results.append(result)
                continue
            
            # Search in block name
            query_lower = query.lower()
            if query_lower in block.name.lower():
                result = SearchResult(
                    block_name=block.name,
                    category=block.category,
                    block_type=block.block_type,
                    match_type="block_name",
                    match_text=block.name,
                    relevance_score=1.0,
                    signals=block.signals
                )
                results.append(result)
                continue
            
            # Search in description
            if query_lower in block.description.lower():
                result = SearchResult(
                    block_name=block.name,
                    category=block.category,
                    block_type=block.block_type,
                    match_type="description",
                    match_text=block.description,
                    relevance_score=0.8,
                    signals=block.signals
                )
                results.append(result)
                continue
            
            # Search in signal names
            for signal in block.signals:
                if query_lower in signal.name.lower():
                    result = SearchResult(
                        block_name=block.name,
                        category=block.category,
                        block_type=block.block_type,
                        match_type="signal_name",
                        match_text=signal.name,
                        relevance_score=0.9,
                        signals=block.signals
                    )
                    results.append(result)
                    break
                    
                # Search in signal descriptions
                if query_lower in signal.description.lower():
                    result = SearchResult(
                        block_name=block.name,
                        category=block.category,
                        block_type=block.block_type,
                        match_type="signal_description",
                        match_text=signal.description,
                        relevance_score=0.7,
                        signals=block.signals
                    )
                    results.append(result)
                    break
        
        # Sort by relevance score (highest first)
        results.sort(key=lambda r: r.relevance_score, reverse=True)
        
        return results
        
    def get_categories(self) -> List[str]:
        """
        Get list of all available categories
        
        Returns:
            List of category names
        """
        all_blocks = self.get_all_blocks()
        categories = set(b.category for b in all_blocks)
        return sorted(list(categories))
        
    def get_block_types(self) -> List[str]:
        """
        Get list of all available block types
        
        Returns:
            List of block type names
        """
        all_blocks = self.get_all_blocks()
        types = set(b.block_type for b in all_blocks)
        return sorted(list(types))
        
    def validate_block_exists(self, block_name: str) -> bool:
        """
        Check if a block exists in registry
        
        Args:
            block_name: Name of block to check
            
        Returns:
            True if block exists, False otherwise
        """
        return self.get_block(block_name) is not None
        
    def validate_signal_exists(self, block_name: str, signal_name: str) -> bool:
        """
        Check if a signal exists for a block
        
        Args:
            block_name: Name of block
            signal_name: Name of signal
            
        Returns:
            True if signal exists, False otherwise
        """
        block = self.get_block(block_name)
        if block is None:
            return False
            
        return any(s.name == signal_name for s in block.signals)
