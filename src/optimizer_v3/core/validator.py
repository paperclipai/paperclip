"""
Optimizer V3 - Data Validator
Validates all data structures, NautilusTrader types, and configurations.
"""

from typing import Any, Dict, List, Optional, Union
from decimal import Decimal
from datetime import datetime

from nautilus_trader.model.objects import Price, Quantity, Money, Currency
from nautilus_trader.model.enums import OrderSide, OrderType, TimeInForce
from nautilus_trader.model.currencies import USD
from nautilus_trader.model.identifiers import InstrumentId, Symbol, Venue

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



class ValidationError(Exception):
    """Raised when validation fails"""
    pass


class DataValidator:
    """
    Comprehensive data validation system for Optimizer V3.
    
    Validates:
    - Strategy configurations
    - NautilusTrader types
    - Training events
    - Trade data
    - Risk parameters
    - Configuration parameters
    
    Args:
        logger: OptimizerLogger instance for logging validation issues
    """
    
    def __init__(self, logger: OptimizerLogger):
        self.logger = logger
    
    def validate_strategy(self, strategy: Dict[str, Any]) -> bool:
        """
        Validate strategy configuration structure.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If strategy is invalid
        """
        self.logger.debug("Validating strategy configuration")
        
        # Check required fields
        required_fields = ['name', 'blocks']
        for field in required_fields:
            if field not in strategy:
                raise ValidationError(f"Missing required field: {field}")
        
        # Validate strategy name
        if not isinstance(strategy['name'], str) or not strategy['name'].strip():
            raise ValidationError("Strategy name must be non-empty string")
        
        # Validate blocks
        if not isinstance(strategy['blocks'], list):
            raise ValidationError("Blocks must be a list")
        
        if len(strategy['blocks']) == 0:
            raise ValidationError("Strategy must have at least one block")
        
        # Validate each block
        for i, block in enumerate(strategy['blocks']):
            self._validate_block(block, i)
        
        self.logger.debug(
            "Strategy validation passed",
            strategy_name=strategy['name'],
            num_blocks=len(strategy['blocks'])
        )
        return True
    
    def _validate_block(self, block: Dict[str, Any], index: int) -> None:
        """
        Validate a single building block.
        
        Args:
            block: Block configuration dictionary
            index: Block index for error messages
            
        Raises:
            ValidationError: If block is invalid
        """
        required_fields = ['name', 'signals']
        for field in required_fields:
            if field not in block:
                raise ValidationError(
                    f"Block {index}: Missing required field '{field}'"
                )
        
        if not isinstance(block['signals'], list):
            raise ValidationError(
                f"Block {index}: Signals must be a list"
            )
        
        if len(block['signals']) == 0:
            raise ValidationError(
                f"Block {index}: Block must have at least one signal"
            )
    
    def validate_price(self, value: Any) -> Price:
        """
        Validate and convert to Price type.
        
        Args:
            value: Value to validate
            
        Returns:
            Valid Price object
            
        Raises:
            ValidationError: If value cannot be converted to Price
        """
        try:
            if isinstance(value, Price):
                return value
            elif isinstance(value, str):
                return Price.from_str(value)
            elif isinstance(value, (int, float, Decimal)):
                return Price(float(value), 2)
            else:
                raise ValidationError(
                    f"Cannot convert {type(value).__name__} to Price"
                )
        except Exception as e:
            raise ValidationError(f"Invalid price value: {str(e)}")
    
    def validate_quantity(self, value: Any) -> Quantity:
        """
        Validate and convert to Quantity type.
        
        Args:
            value: Value to validate
            
        Returns:
            Valid Quantity object
            
        Raises:
            ValidationError: If value cannot be converted to Quantity
        """
        try:
            if isinstance(value, Quantity):
                return value
            elif isinstance(value, str):
                return Quantity.from_str(value)
            elif isinstance(value, (int, float, Decimal)):
                return Quantity(float(value), 8)
            else:
                raise ValidationError(
                    f"Cannot convert {type(value).__name__} to Quantity"
                )
        except Exception as e:
            raise ValidationError(f"Invalid quantity value: {str(e)}")
    
    def validate_money(self, value: Any, currency: Currency = USD) -> Money:
        """
        Validate and convert to Money type.
        
        Args:
            value: Value to validate
            currency: Currency instance (default: USD)
            
        Returns:
            Valid Money object
            
        Raises:
            ValidationError: If value cannot be converted to Money
        """
        try:
            if isinstance(value, Money):
                return value
            elif isinstance(value, (int, float, Decimal, str)):
                return Money(str(value), currency)
            else:
                raise ValidationError(
                    f"Cannot convert {type(value).__name__} to Money"
                )
        except Exception as e:
            raise ValidationError(f"Invalid money value: {str(e)}")
    
    def validate_order_side(self, value: Any) -> OrderSide:
        """
        Validate and convert to OrderSide enum.
        
        Args:
            value: Value to validate
            
        Returns:
            Valid OrderSide enum
            
        Raises:
            ValidationError: If value is not valid OrderSide
        """
        if isinstance(value, OrderSide):
            return value
        
        if isinstance(value, str):
            value = value.upper()
            if value == 'BUY':
                return OrderSide.BUY
            elif value == 'SELL':
                return OrderSide.SELL
        
        raise ValidationError(
            f"Invalid OrderSide: {value}. Must be 'BUY' or 'SELL'"
        )
    
    def validate_training_event(self, event: Dict[str, Any]) -> bool:
        """
        Validate training event structure.
        
        Args:
            event: Training event dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If event is invalid
        """
        required_fields = [
            'timestamp',
            'signal_name',
            'price',
            'position_side'
        ]
        
        for field in required_fields:
            if field not in event:
                raise ValidationError(
                    f"Training event missing required field: {field}"
                )
        
        # Validate timestamp
        if not isinstance(event['timestamp'], (str, datetime)):
            raise ValidationError("Timestamp must be string or datetime")
        
        # Validate price
        self.validate_price(event['price'])
        
        # Validate position side
        self.validate_order_side(event['position_side'])
        
        return True
    
    def validate_trade(self, trade: Dict[str, Any]) -> bool:
        """
        Validate trade data structure.
        
        Args:
            trade: Trade data dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If trade is invalid
        """
        required_fields = [
            'entry_price',
            'exit_price',
            'quantity',
            'side',
            'pnl'
        ]
        
        for field in required_fields:
            if field not in trade:
                raise ValidationError(
                    f"Trade missing required field: {field}"
                )
        
        # Validate prices
        self.validate_price(trade['entry_price'])
        self.validate_price(trade['exit_price'])
        
        # Validate quantity
        self.validate_quantity(trade['quantity'])
        
        # Validate side
        self.validate_order_side(trade['side'])
        
        # Validate PnL
        self.validate_money(trade['pnl'])
        
        return True
    
    def validate_position(self, position: Dict[str, Any]) -> bool:
        """
        Validate position data structure.
        
        Args:
            position: Position data dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If position is invalid
        """
        required_fields = [
            'instrument_id',
            'side',
            'quantity',
            'entry_price'
        ]
        
        for field in required_fields:
            if field not in position:
                raise ValidationError(
                    f"Position missing required field: {field}"
                )
        
        # Validate quantity
        self.validate_quantity(position['quantity'])
        
        # Validate entry price
        self.validate_price(position['entry_price'])
        
        # Validate side
        self.validate_order_side(position['side'])
        
        return True
    
    def validate_risk_parameters(self, params: Dict[str, Any]) -> bool:
        """
        Validate risk management parameters.
        
        Args:
            params: Risk parameters dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If parameters are invalid
        """
        required_fields = [
            'min_risk_reward',
            'risk_percent',
            'max_leverage'
        ]
        
        for field in required_fields:
            if field not in params:
                raise ValidationError(
                    f"Risk parameters missing required field: {field}"
                )
        
        # Validate min_risk_reward
        min_rr = Decimal(str(params['min_risk_reward']))
        if min_rr < Decimal('1.0'):
            raise ValidationError(
                f"min_risk_reward must be >= 1.0, got {min_rr}"
            )
        
        # Validate risk_percent
        risk_pct = Decimal(str(params['risk_percent']))
        if risk_pct <= Decimal('0') or risk_pct > Decimal('100'):
            raise ValidationError(
                f"risk_percent must be between 0 and 100, got {risk_pct}"
            )
        
        # Validate max_leverage
        max_lev = Decimal(str(params['max_leverage']))
        if max_lev < Decimal('1.0'):
            raise ValidationError(
                f"max_leverage must be >= 1.0, got {max_lev}"
            )
        
        return True
    
    def validate_optimization_range(
        self,
        range_config: Dict[str, Any]
    ) -> bool:
        """
        Validate optimization range configuration.
        
        Args:
            range_config: Range configuration dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If range is invalid
        """
        required_fields = ['min', 'max']
        
        for field in required_fields:
            if field not in range_config:
                raise ValidationError(
                    f"Range configuration missing required field: {field}"
                )
        
        # Validate min <= max
        min_val = Decimal(str(range_config['min']))
        max_val = Decimal(str(range_config['max']))
        
        if min_val > max_val:
            raise ValidationError(
                f"Range min ({min_val}) must be <= max ({max_val})"
            )
        
        return True
    
    def validate_timing_constraint(
        self,
        constraint: Dict[str, Any]
    ) -> bool:
        """
        Validate timing constraint configuration.
        
        Args:
            constraint: Timing constraint dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If constraint is invalid
        """
        if 'max_candles' in constraint:
            max_candles = int(constraint['max_candles'])
            if max_candles <= 0:
                raise ValidationError(
                    f"max_candles must be > 0, got {max_candles}"
                )
        
        if 'min_candles' in constraint:
            min_candles = int(constraint['min_candles'])
            if min_candles < 0:
                raise ValidationError(
                    f"min_candles must be >= 0, got {min_candles}"
                )
            
            if 'max_candles' in constraint:
                if min_candles > constraint['max_candles']:
                    raise ValidationError(
                        "min_candles must be <= max_candles"
                    )
        
        return True
    
    def validate_configuration(self, config: Dict[str, Any]) -> bool:
        """
        Validate complete optimizer configuration.
        
        Args:
            config: Configuration dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If configuration is invalid
        """
        self.logger.debug("Validating optimizer configuration")
        
        # Validate capital if present
        if 'capital' in config:
            self.validate_money(
                config['capital']['amount'],
                config['capital'].get('currency', 'USD')
            )
        
        # Validate risk parameters if present
        if 'risk' in config:
            self.validate_risk_parameters(config['risk'])
        
        # Validate optimization ranges if present
        if 'optimization_ranges' in config:
            ranges = config['optimization_ranges']
            for param, range_config in ranges.items():
                if isinstance(range_config, dict) and 'min' in range_config:
                    self.validate_optimization_range(range_config)
        
        self.logger.debug("Configuration validation passed")
        return True
