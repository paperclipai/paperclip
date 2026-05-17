"""
Data Validators
Task 0.4: Data Validation

Validates all NautilusTrader data before database storage.
Ensures type correctness and prevents invalid data.
"""

from typing import Dict, Any, List, Optional
from datetime import datetime
from nautilus_trader.model.objects import Quantity, Price, Money
from nautilus_trader.model.identifiers import InstrumentId
from nautilus_trader.model.enums import OrderSide, PositionSide

from .nautilus_types import NautilusTypeConverter


class ValidationError(Exception):
    """Raised when data validation fails"""
    pass


class NautilusDataValidator:
    """
    Validate all NautilusTrader data before storage
    
    All validators raise ValidationError if validation fails
    """
    
    # ========================================================================
    # Trade Event Validation
    # ========================================================================
    
    @staticmethod
    def validate_trade_event(event: Dict[str, Any]) -> bool:
        """
        Validate trade event data
        
        Args:
            event: Dictionary with trade event fields
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        required_fields = ['instrument_id', 'order_side', 'quantity', 'price', 'money']
        
        # Check required fields
        for field in required_fields:
            if field not in event:
                raise ValidationError(f"Missing required field: {field}")
        
        # Validate instrument_id
        if not isinstance(event['instrument_id'], str):
            raise ValidationError("instrument_id must be string")
        if not NautilusTypeConverter.is_valid_instrument_id(event['instrument_id']):
            raise ValidationError(f"Invalid instrument_id: {event['instrument_id']}")
        
        # Validate order_side
        if not isinstance(event['order_side'], str):
            raise ValidationError("order_side must be string")
        if event['order_side'].upper() not in ['BUY', 'SELL']:
            raise ValidationError(f"Invalid order_side: {event['order_side']}")
        
        # Validate quantity
        if not isinstance(event['quantity'], str):
            raise ValidationError("quantity must be string")
        if not NautilusTypeConverter.is_valid_quantity(event['quantity']):
            raise ValidationError(f"Invalid quantity: {event['quantity']}")
        
        # Validate price
        if not isinstance(event['price'], str):
            raise ValidationError("price must be string")
        if not NautilusTypeConverter.is_valid_price(event['price']):
            raise ValidationError(f"Invalid price: {event['price']}")
        
        # Validate money
        if not isinstance(event['money'], str):
            raise ValidationError("money must be string")
        if not NautilusTypeConverter.is_valid_money(event['money']):
            raise ValidationError(f"Invalid money: {event['money']}")
        
        return True
    
    # ========================================================================
    # Strategy Configuration Validation
    # ========================================================================
    
    @staticmethod
    def validate_strategy_config(config: Dict[str, Any]) -> bool:
        """
        Validate strategy configuration
        
        Args:
            config: Strategy configuration dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        required_fields = ['strategy_id', 'parameters']
        
        for field in required_fields:
            if field not in config:
                raise ValidationError(f"Missing required field: {field}")
        
        # Validate strategy_id
        if not isinstance(config['strategy_id'], str) or not config['strategy_id']:
            raise ValidationError("strategy_id must be non-empty string")
        
        # Validate parameters
        if not isinstance(config['parameters'], dict):
            raise ValidationError("parameters must be dictionary")
        
        return True
    
    # ========================================================================
    # Performance Metrics Validation
    # ========================================================================
    
    @staticmethod
    def validate_performance_metrics(metrics: Dict[str, Any]) -> bool:
        """
        Validate performance metrics
        
        Args:
            metrics: Performance metrics dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        # Validate numeric metrics
        numeric_fields = [
            'sharpe_ratio', 'sortino_ratio', 'profit_factor', 
            'win_rate', 'total_return_pct', 'max_drawdown_pct'
        ]
        
        for field in numeric_fields:
            if field in metrics:
                value = metrics[field]
                if value is not None and not isinstance(value, (int, float)):
                    raise ValidationError(f"{field} must be numeric, got {type(value)}")
        
        # Validate money fields
        money_fields = ['total_pnl', 'max_drawdown', 'avg_win', 'avg_loss']
        
        for field in money_fields:
            if field in metrics:
                value = metrics[field]
                if value is not None:
                    if not isinstance(value, str):
                        raise ValidationError(f"{field} must be string (Money type)")
                    if not NautilusTypeConverter.is_valid_money(value):
                        raise ValidationError(f"Invalid money value for {field}: {value}")
        
        # Validate trade counts
        count_fields = ['total_trades', 'winning_trades', 'losing_trades']
        
        for field in count_fields:
            if field in metrics:
                value = metrics[field]
                if value is not None:
                    if not isinstance(value, int) or value < 0:
                        raise ValidationError(f"{field} must be non-negative integer")
        
        # Validate win rate
        if 'win_rate' in metrics and metrics['win_rate'] is not None:
            if not (0.0 <= metrics['win_rate'] <= 1.0):
                raise ValidationError(f"win_rate must be between 0 and 1, got {metrics['win_rate']}")
        
        return True
    
    # ========================================================================
    # Signal Event Validation
    # ========================================================================
    
    @staticmethod
    def validate_signal_event(event: Dict[str, Any]) -> bool:
        """
        Validate signal event data
        
        Args:
            event: Signal event dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        required_fields = ['signal_name', 'signal_type', 'timestamp', 'instrument_id', 'price']
        
        for field in required_fields:
            if field not in event:
                raise ValidationError(f"Missing required field: {field}")
        
        # Validate signal_name
        if not isinstance(event['signal_name'], str) or not event['signal_name']:
            raise ValidationError("signal_name must be non-empty string")
        
        # Validate signal_type
        valid_types = ['entry', 'exit', 'filter']
        if event['signal_type'] not in valid_types:
            raise ValidationError(f"signal_type must be one of {valid_types}")
        
        # Validate timestamp
        if not isinstance(event['timestamp'], datetime):
            raise ValidationError("timestamp must be datetime object")
        
        # Validate instrument_id
        if not NautilusTypeConverter.is_valid_instrument_id(event['instrument_id']):
            raise ValidationError(f"Invalid instrument_id: {event['instrument_id']}")
        
        # Validate price
        if not NautilusTypeConverter.is_valid_price(event['price']):
            raise ValidationError(f"Invalid price: {event['price']}")
        
        # Validate optional fields
        if 'signal_strength' in event and event['signal_strength'] is not None:
            if not isinstance(event['signal_strength'], (int, float)):
                raise ValidationError("signal_strength must be numeric")
        
        if 'confidence' in event and event['confidence'] is not None:
            if not isinstance(event['confidence'], (int, float)):
                raise ValidationError("confidence must be numeric")
            if not (0.0 <= event['confidence'] <= 1.0):
                raise ValidationError("confidence must be between 0 and 1")
        
        return True
    
    # ========================================================================
    # Optimization Run Validation
    # ========================================================================
    
    @staticmethod
    def validate_optimization_run(run_data: Dict[str, Any]) -> bool:
        """
        Validate optimization run data
        
        Args:
            run_data: Optimization run dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        required_fields = ['strategy_id', 'strategy_config', 'backtest_config', 'optimization_params']
        
        for field in required_fields:
            if field not in run_data:
                raise ValidationError(f"Missing required field: {field}")
        
        # Validate strategy_id
        if not isinstance(run_data['strategy_id'], str) or not run_data['strategy_id']:
            raise ValidationError("strategy_id must be non-empty string")
        
        # Validate configs are dictionaries
        for config_field in ['strategy_config', 'backtest_config', 'optimization_params']:
            if not isinstance(run_data[config_field], dict):
                raise ValidationError(f"{config_field} must be dictionary")
        
        # Validate status if provided
        if 'status' in run_data:
            valid_statuses = ['pending', 'running', 'completed', 'failed', 'cancelled']
            if run_data['status'] not in valid_statuses:
                raise ValidationError(f"status must be one of {valid_statuses}")
        
        # Validate variation counts if provided
        if 'total_variations' in run_data:
            if not isinstance(run_data['total_variations'], int) or run_data['total_variations'] < 0:
                raise ValidationError("total_variations must be non-negative integer")
        
        return True
    
    # ========================================================================
    # Training Session Validation
    # ========================================================================
    
    @staticmethod
    def validate_training_session(session_data: Dict[str, Any]) -> bool:
        """
        Validate training session data
        
        Args:
            session_data: Training session dictionary
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        required_fields = ['session_name', 'model_type', 'training_config', 
                          'training_start_date', 'training_end_date']
        
        for field in required_fields:
            if field not in session_data:
                raise ValidationError(f"Missing required field: {field}")
        
        # Validate session_name
        if not isinstance(session_data['session_name'], str) or not session_data['session_name']:
            raise ValidationError("session_name must be non-empty string")
        
        # Validate model_type
        if not isinstance(session_data['model_type'], str) or not session_data['model_type']:
            raise ValidationError("model_type must be non-empty string")
        
        # Validate training_config
        if not isinstance(session_data['training_config'], dict):
            raise ValidationError("training_config must be dictionary")
        
        # Validate dates
        for date_field in ['training_start_date', 'training_end_date']:
            if not isinstance(session_data[date_field], datetime):
                raise ValidationError(f"{date_field} must be datetime object")
        
        # Validate date range
        if session_data['training_end_date'] <= session_data['training_start_date']:
            raise ValidationError("training_end_date must be after training_start_date")
        
        # Validate metrics if provided
        metric_fields = ['training_accuracy', 'validation_accuracy', 'precision', 'recall', 'f1_score']
        for field in metric_fields:
            if field in session_data and session_data[field] is not None:
                value = session_data[field]
                if not isinstance(value, (int, float)):
                    raise ValidationError(f"{field} must be numeric")
                if not (0.0 <= value <= 1.0):
                    raise ValidationError(f"{field} must be between 0 and 1")
        
        return True
    
    # ========================================================================
    # Batch Validation
    # ========================================================================
    
    @staticmethod
    def validate_batch(data_list: List[Dict[str, Any]], validator_func) -> List[str]:
        """
        Validate a batch of data items
        
        Args:
            data_list: List of data dictionaries
            validator_func: Validation function to apply
            
        Returns:
            List of error messages (empty if all valid)
        """
        errors = []
        
        for i, data in enumerate(data_list):
            try:
                validator_func(data)
            except ValidationError as e:
                errors.append(f"Item {i}: {str(e)}")
        
        return errors
    
    # ========================================================================
    # Utility Methods
    # ========================================================================
    
    @staticmethod
    def validate_required_fields(data: Dict[str, Any], required_fields: List[str]) -> bool:
        """
        Generic validator for required fields
        
        Args:
            data: Data dictionary
            required_fields: List of required field names
            
        Returns:
            True if all required fields present
            
        Raises:
            ValidationError: If any required field missing
        """
        missing_fields = [field for field in required_fields if field not in data]
        
        if missing_fields:
            raise ValidationError(f"Missing required fields: {', '.join(missing_fields)}")
        
        return True
    
    @staticmethod
    def validate_numeric_range(value: Any, field_name: str, min_val: Optional[float] = None, 
                               max_val: Optional[float] = None) -> bool:
        """
        Validate numeric value is within range
        
        Args:
            value: Value to validate
            field_name: Name of field (for error message)
            min_val: Minimum allowed value (optional)
            max_val: Maximum allowed value (optional)
            
        Returns:
            True if valid
            
        Raises:
            ValidationError: If validation fails
        """
        if value is None:
            return True
        
        if not isinstance(value, (int, float)):
            raise ValidationError(f"{field_name} must be numeric, got {type(value)}")
        
        if min_val is not None and value < min_val:
            raise ValidationError(f"{field_name} must be >= {min_val}, got {value}")
        
        if max_val is not None and value > max_val:
            raise ValidationError(f"{field_name} must be <= {max_val}, got {value}")
        
        return True
