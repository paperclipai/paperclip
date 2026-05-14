"""
Block Registry Adapter
Adapts BlockRegistry to the interface expected by RegistryInterface

This adapter converts BlockRegistry's class methods and BlockMetadata objects
to the dictionary-based interface expected by the strategy builder components.

Author: Strategy Builder Team
Date: 2026-01-16
"""

from typing import List, Dict, Any, Optional

import logging
logger = logging.getLogger(__name__)


try:
    from src.detectors.building_blocks.registry import BlockRegistry, BlockMetadata
    BLOCK_REGISTRY_AVAILABLE = True
except ImportError:
    BLOCK_REGISTRY_AVAILABLE = False
    BlockRegistry = None
    BlockMetadata = None

# Import institutional logger
try:
    from src.strategy_builder.utils import logger, LogComponent
    LOGGER_AVAILABLE = True
except ImportError:
    LOGGER_AVAILABLE = False
    logger = None
    LogComponent = None


class BlockRegistryAdapter:
    """
    Adapter that wraps BlockRegistry to provide the expected interface.
    
    Converts BlockMetadata objects to dictionaries with the structure
    expected by RegistryInterface.
    """
    
    def __init__(self):
        """Initialize the adapter."""
        if LOGGER_AVAILABLE and logger:
            logger.info(LogComponent.REGISTRY_ADAPTER, "Initializing BlockRegistryAdapter")
        
        if not BLOCK_REGISTRY_AVAILABLE:
            if LOGGER_AVAILABLE and logger:
                logger.error(LogComponent.REGISTRY_ADAPTER, "BlockRegistry not available")
            raise ImportError("BlockRegistry not available")
        
        if LOGGER_AVAILABLE and logger:
            logger.info(LogComponent.REGISTRY_ADAPTER, "BlockRegistryAdapter initialized successfully")
    
    def get_all_blocks(self) -> List[Dict[str, Any]]:
        """
        Get all blocks as a list of dictionaries.
        
        Returns:
            List of block dictionaries with expected structure
        """
        blocks = []
        
        # Get all blocks from BlockRegistry
        all_blocks = BlockRegistry.get_all_blocks()
        
        for name, metadata in all_blocks.items():
            block_dict = self._convert_metadata_to_dict(metadata)
            blocks.append(block_dict)
        
        return blocks
    
    def get_block(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a specific block by name.
        
        Args:
            name: Block name
            
        Returns:
            Block dictionary or None if not found
        """
        metadata = BlockRegistry.get_block(name)
        
        if metadata is None:
            return None
        
        return self._convert_metadata_to_dict(metadata)
    
    def get_block_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a specific block by name (alias for get_block).
        
        This method exists for compatibility with different interfaces.
        
        Args:
            name: Block name
            
        Returns:
            Block dictionary or None if not found
        """
        return self.get_block(name)
    
    def _convert_metadata_to_dict(self, metadata: 'BlockMetadata') -> Dict[str, Any]:
        """
        Convert BlockMetadata to dictionary format expected by RegistryInterface.
        
        Args:
            metadata: BlockMetadata object
            
        Returns:
            Dictionary with block information
        """
        # Extract signals from signal_tiers
        signals = []
        for signal_name, tier_info in metadata.signal_tiers.items():
            # Calculate example count and percentage (mock data for UI)
            # In production, this would come from real historical analysis
            count = self._estimate_signal_count(signal_name)
            percentage = self._estimate_signal_percentage(signal_name)
            
            signals.append({
                'name': signal_name,
                'count': count,
                'percentage': percentage,
                'description': self._get_signal_description(signal_name, tier_info),
                'ui_visible': tier_info.get('ui_visible', True)  # Extract from registry
            })
        
        return {
            'name': metadata.name,
            'category': metadata.category,
            'type': self._determine_block_type(metadata.category),
            'weight': metadata.default_weight,
            'description': metadata.description,
            'signals': signals,
            'metadata': {
                'class_name': metadata.class_name,
                'module_path': metadata.module_path,
                'tags': metadata.tags,
                'valid_signals': metadata.valid_signals
            }
        }
    
    def _determine_block_type(self, category: str) -> str:
        """
        Determine block type from category.
        
        Args:
            category: Block category
            
        Returns:
            Block type (EVENT, SIGNAL, CONTEXT, or HYBRID)
        """
        # Map categories to types
        event_categories = {'PATTERNS', 'MARKET_STRUCTURE', 'PRICE_ACTION'}
        signal_categories = {'OSCILLATORS', 'MOVING_AVERAGES', 'VOLATILITY'}
        context_categories = {'SESSIONS', 'FIBONACCI', 'PRICE_LEVELS'}
        
        if category in event_categories:
            return 'EVENT'
        elif category in signal_categories:
            return 'SIGNAL'
        elif category in context_categories:
            return 'CONTEXT'
        else:
            return 'HYBRID'
    
    def _estimate_signal_count(self, signal_name: str) -> int:
        """
        Estimate signal occurrence count for UI display.
        
        In production, this would query actual historical data.
        For now, provides reasonable estimates based on signal type.
        
        Args:
            signal_name: Signal name
            
        Returns:
            Estimated occurrence count
        """
        # Status signals rarely occur
        if signal_name in ['ERROR', 'INSUFFICIENT_DATA', 'NO_SIGNAL']:
            return 0
        
        # Directional signals (common)
        if signal_name in ['BULLISH', 'BEARISH', 'NEUTRAL']:
            if signal_name == 'NEUTRAL':
                return 800
            else:
                return 100
        
        # Pattern confirmation signals (rare)
        if 'CONFIRMED' in signal_name or 'BREAKDOWN' in signal_name:
            return 25
        
        # Forming/pending signals (more common)
        if 'FORMING' in signal_name or 'PENDING' in signal_name:
            return 75
        
        # Default
        return 50
    
    def _estimate_signal_percentage(self, signal_name: str) -> float:
        """
        Estimate signal occurrence percentage.
        
        Args:
            signal_name: Signal name
            
        Returns:
            Estimated percentage
        """
        count = self._estimate_signal_count(signal_name)
        # Assume ~1000 total data points for percentage calculation
        return (count / 1000.0) * 100.0
    
    def _get_signal_description(self, signal_name: str, tier_info: Dict[str, Any]) -> str:
        """
        Get human-readable signal description.
        
        Args:
            signal_name: Signal name
            tier_info: Tier information from registry
            
        Returns:
            Description string
        """
        # Extract from tier_info if available
        if 'description' in tier_info:
            return tier_info['description']
        
        # Generate description from signal name
        return signal_name.replace('_', ' ').title()
