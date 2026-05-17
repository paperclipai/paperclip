"""
NautilusTrader Type Converters
Task 0.4: Type Conversion Utilities

Converts between database string storage and NautilusTrader types:
- Quantity <-> String
- Price <-> String
- Money <-> String
- InstrumentId <-> String
- Enums <-> String
"""

from typing import Optional
from nautilus_trader.model.objects import Quantity, Price, Money
from nautilus_trader.model.identifiers import InstrumentId, Symbol, Venue
from nautilus_trader.model.enums import OrderSide, PositionSide, OrderType, TimeInForce
from nautilus_trader.model.currencies import Currency


class NautilusTypeConverter:
    """
    Convert between string storage and NautilusTrader types
    
    All conversions maintain precision by using string representation.
    Never use float for financial values.
    """
    
    # ========================================================================
    # Quantity Conversions
    # ========================================================================
    
    @staticmethod
    def to_quantity(value: str) -> Quantity:
        """
        Convert string to Quantity
        
        Args:
            value: String representation of quantity (e.g., "1.5")
            
        Returns:
            Quantity object
            
        Example:
            >>> qty = NautilusTypeConverter.to_quantity("1.5")
            >>> qty
            Quantity.from_str('1.5')
        """
        return Quantity.from_str(value)
    
    @staticmethod
    def from_quantity(quantity: Quantity) -> str:
        """
        Convert Quantity to string for storage
        
        Args:
            quantity: Quantity object
            
        Returns:
            String representation
            
        Example:
            >>> qty_str = NautilusTypeConverter.from_quantity(Quantity.from_str("1.5"))
            >>> qty_str
            '1.5'
        """
        return str(quantity)
    
    # ========================================================================
    # Price Conversions
    # ========================================================================
    
    @staticmethod
    def to_price(value: str, precision: int = 2) -> Price:
        """
        Convert string to Price
        
        Args:
            value: String representation of price (e.g., "50000.50")
            precision: Price precision (default: 2)
            
        Returns:
            Price object
            
        Example:
            >>> price = NautilusTypeConverter.to_price("50000.50")
            >>> price
            Price.from_str('50000.50')
        """
        return Price.from_str(value)
    
    @staticmethod
    def from_price(price: Price) -> str:
        """
        Convert Price to string for storage
        
        Args:
            price: Price object
            
        Returns:
            String representation
            
        Example:
            >>> price_str = NautilusTypeConverter.from_price(Price.from_str("50000.50"))
            >>> price_str
            '50000.50'
        """
        return str(price)
    
    # ========================================================================
    # Money Conversions
    # ========================================================================
    
    @staticmethod
    def to_money(value: str) -> Money:
        """
        Convert string to Money
        
        Args:
            value: String representation of money (e.g., "1000.50 USD")
            
        Returns:
            Money object
            
        Example:
            >>> money = NautilusTypeConverter.to_money("1000.50 USD")
            >>> money
            Money('1000.50 USD')
        """
        return Money.from_str(value)
    
    @staticmethod
    def from_money(money: Money) -> str:
        """
        Convert Money to string for storage
        
        Args:
            money: Money object
            
        Returns:
            String representation with currency
            
        Example:
            >>> money_str = NautilusTypeConverter.from_money(Money.from_str("1000.50 USD"))
            >>> money_str
            '1000.50 USD'
        """
        return str(money)
    
    # ========================================================================
    # InstrumentId Conversions
    # ========================================================================
    
    @staticmethod
    def to_instrument_id(value: str) -> InstrumentId:
        """
        Convert string to InstrumentId
        
        Args:
            value: String representation (e.g., "BTC/USDT.BINANCE")
            
        Returns:
            InstrumentId object
            
        Example:
            >>> inst_id = NautilusTypeConverter.to_instrument_id("BTC/USDT.BINANCE")
            >>> inst_id
            InstrumentId.from_str('BTC/USDT.BINANCE')
        """
        return InstrumentId.from_str(value)
    
    @staticmethod
    def from_instrument_id(instrument_id: InstrumentId) -> str:
        """
        Convert InstrumentId to string for storage
        
        Args:
            instrument_id: InstrumentId object
            
        Returns:
            String representation
            
        Example:
            >>> inst_str = NautilusTypeConverter.from_instrument_id(instrument_id)
            >>> inst_str
            'BTC/USDT.BINANCE'
        """
        return str(instrument_id)
    
    # ========================================================================
    # Enum Conversions
    # ========================================================================
    
    @staticmethod
    def to_order_side(value: str) -> OrderSide:
        """
        Convert string to OrderSide enum
        
        Args:
            value: String ("BUY" or "SELL")
            
        Returns:
            OrderSide enum
        """
        return OrderSide[value.upper()]
    
    @staticmethod
    def from_order_side(order_side: OrderSide) -> str:
        """Convert OrderSide enum to string"""
        return order_side.name
    
    @staticmethod
    def to_position_side(value: str) -> PositionSide:
        """
        Convert string to PositionSide enum
        
        Args:
            value: String ("LONG", "SHORT", or "FLAT")
            
        Returns:
            PositionSide enum
        """
        return PositionSide[value.upper()]
    
    @staticmethod
    def from_position_side(position_side: PositionSide) -> str:
        """Convert PositionSide enum to string"""
        return position_side.name
    
    @staticmethod
    def to_order_type(value: str) -> OrderType:
        """
        Convert string to OrderType enum
        
        Args:
            value: String (e.g., "MARKET", "LIMIT")
            
        Returns:
            OrderType enum
        """
        return OrderType[value.upper()]
    
    @staticmethod
    def from_order_type(order_type: OrderType) -> str:
        """Convert OrderType enum to string"""
        return order_type.name
    
    @staticmethod
    def to_time_in_force(value: str) -> TimeInForce:
        """
        Convert string to TimeInForce enum
        
        Args:
            value: String (e.g., "GTC", "IOC", "FOK")
            
        Returns:
            TimeInForce enum
        """
        return TimeInForce[value.upper()]
    
    @staticmethod
    def from_time_in_force(time_in_force: TimeInForce) -> str:
        """Convert TimeInForce enum to string"""
        return time_in_force.name
    
    # ========================================================================
    # Batch Conversions
    # ========================================================================
    
    @staticmethod
    def convert_trade_event_to_db(event: dict) -> dict:
        """
        Convert trade event with NautilusTrader types to database format
        
        Args:
            event: Dictionary with NautilusTrader objects
            
        Returns:
            Dictionary with string representations
            
        Example:
            >>> event = {
            ...     'instrument_id': InstrumentId.from_str("BTC/USDT.BINANCE"),
            ...     'order_side': OrderSide.BUY,
            ...     'quantity': Quantity.from_str("1.0"),
            ...     'price': Price.from_str("50000.00"),
            ...     'money': Money.from_str("50000.00 USD")
            ... }
            >>> db_event = NautilusTypeConverter.convert_trade_event_to_db(event)
        """
        return {
            'instrument_id': NautilusTypeConverter.from_instrument_id(event['instrument_id'])
                if isinstance(event.get('instrument_id'), InstrumentId) else event.get('instrument_id'),
            'order_side': NautilusTypeConverter.from_order_side(event['order_side'])
                if isinstance(event.get('order_side'), OrderSide) else event.get('order_side'),
            'quantity': NautilusTypeConverter.from_quantity(event['quantity'])
                if isinstance(event.get('quantity'), Quantity) else event.get('quantity'),
            'price': NautilusTypeConverter.from_price(event['price'])
                if isinstance(event.get('price'), Price) else event.get('price'),
            'money': NautilusTypeConverter.from_money(event['money'])
                if isinstance(event.get('money'), Money) else event.get('money'),
        }
    
    @staticmethod
    def convert_trade_event_from_db(db_event: dict) -> dict:
        """
        Convert database trade event to NautilusTrader types
        
        Args:
            db_event: Dictionary with string representations
            
        Returns:
            Dictionary with NautilusTrader objects
        """
        return {
            'instrument_id': NautilusTypeConverter.to_instrument_id(db_event['instrument_id']),
            'order_side': NautilusTypeConverter.to_order_side(db_event['order_side']),
            'quantity': NautilusTypeConverter.to_quantity(db_event['quantity']),
            'price': NautilusTypeConverter.to_price(db_event['price']),
            'money': NautilusTypeConverter.to_money(db_event['money']),
        }
    
    # ========================================================================
    # Utility Methods
    # ========================================================================
    
    @staticmethod
    def is_valid_quantity(value: str) -> bool:
        """Check if string is valid Quantity representation"""
        try:
            Quantity.from_str(value)
            return True
        except (ValueError, TypeError):
            return False
    
    @staticmethod
    def is_valid_price(value: str) -> bool:
        """Check if string is valid Price representation"""
        try:
            Price.from_str(value)
            return True
        except (ValueError, TypeError):
            return False
    
    @staticmethod
    def is_valid_money(value: str) -> bool:
        """Check if string is valid Money representation"""
        try:
            Money.from_str(value)
            return True
        except (ValueError, TypeError):
            return False
    
    @staticmethod
    def is_valid_instrument_id(value: str) -> bool:
        """Check if string is valid InstrumentId representation"""
        try:
            InstrumentId.from_str(value)
            return True
        except (ValueError, TypeError):
            return False


# Convenience aliases
to_quantity = NautilusTypeConverter.to_quantity
from_quantity = NautilusTypeConverter.from_quantity
to_price = NautilusTypeConverter.to_price
from_price = NautilusTypeConverter.from_price
to_money = NautilusTypeConverter.to_money
from_money = NautilusTypeConverter.from_money
to_instrument_id = NautilusTypeConverter.to_instrument_id
from_instrument_id = NautilusTypeConverter.from_instrument_id
