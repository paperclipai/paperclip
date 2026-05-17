"""
Training Event ORM Model - Sprint 2.1, Task 2.1.14
==================================================

Database schema for training event storage.
Stores historical signal analysis results for optimal parameter calculation.

CRITICAL: Uses SQLAlchemy ORM with proper types for institutional data integrity.
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import Column, Integer, String, DateTime, Numeric, Boolean, Text, Index
from sqlalchemy.ext.declarative import declarative_base

# Use existing Base from optimizer_v3 models
from src.optimizer_v3.models.base import Base


class TrainingEvent(Base):
    """
    Training Event Model
    
    Stores signal analysis results for calculating optimal parameters.
    Each row represents one signal occurrence with forward-looking analysis.
    
    SCHEMA DESIGN:
    - Composite key: (signal_name, timeframe, timestamp)
    - Indexes on: signal_name, timeframe, timestamp, block_name
    - Proper Decimal types for financial precision
    - Boolean flags for validation states
    - Text field for metadata/notes
    
    USAGE:
    - Store results from NautilusTrainingSystem
    - Query for OptimalParameterCalculator
    - Track signal performance over time
    - Support statistical validation
    """
    
    __tablename__ = 'training_events'
    
    # Primary Key
    id = Column(Integer, primary_key=True, autoincrement=True)
    
    # Signal Identification
    block_name = Column(String(100), nullable=False, index=True)
    signal_name = Column(String(100), nullable=False, index=True)
    timeframe = Column(String(10), nullable=False, index=True)  # '5m', '15m', '1h', '4h'
    
    # Timestamp
    timestamp = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    
    # Signal Entry Data
    entry_price = Column(Numeric(18, 8), nullable=False)  # Entry price (8 decimal precision)
    instrument = Column(String(20), nullable=False, default='BTC-USD')
    
    # Forward Analysis Results (Decimal precision for institutional accuracy)
    max_favorable_move = Column(Numeric(10, 6), nullable=True)  # Maximum favorable price movement (%)
    max_adverse_move = Column(Numeric(10, 6), nullable=True)    # Maximum adverse price movement (%)
    final_move = Column(Numeric(10, 6), nullable=True)          # Final price movement after N bars (%)
    
    # Volatility & Position Sizing
    volatility_atr = Column(Numeric(10, 6), nullable=True)      # ATR (Average True Range)
    position_size = Column(Numeric(18, 8), nullable=True)       # Calculated position size (BTC)
    
    # Trade Outcome
    simulated_pnl = Column(Numeric(18, 2), nullable=True)       # Simulated P&L (USD, 2 decimals)
    is_winning_trade = Column(Boolean, nullable=True)           # True if PnL > 0
    
    # Price Impact
    price_impact_usd = Column(Numeric(18, 2), nullable=True)    # Price impact in USD
    
    # Analysis Window
    forward_bars = Column(Integer, nullable=False, default=10)   # Number of bars analyzed forward
    bars_to_max_favorable = Column(Integer, nullable=True)       # Bars to reach max favorable
    bars_to_max_adverse = Column(Integer, nullable=True)         # Bars to reach max adverse
    
    # Validation Flags
    is_valid_signal = Column(Boolean, nullable=False, default=True)
    has_sufficient_data = Column(Boolean, nullable=False, default=True)
    meets_min_criteria = Column(Boolean, nullable=False, default=True)
    
    # Statistical Metadata
    sample_group = Column(String(50), nullable=True)             # For grouping in analysis
    training_mode = Column(String(20), nullable=False)           # 'testing' or 'production'
    analysis_version = Column(String(20), nullable=True)         # Version of analysis algorithm
    
    # Additional Metadata
    notes = Column(Text, nullable=True)                          # JSON or text notes
    
    # Indexes for performance (defined at class level)
    __table_args__ = (
        # Composite index for common queries
        Index('idx_signal_timeframe', 'signal_name', 'timeframe'),
        Index('idx_block_timeframe', 'block_name', 'timeframe'),
        Index('idx_timestamp_signal', 'timestamp', 'signal_name'),
        
        # Index for validation queries
        Index('idx_valid_signals', 'is_valid_signal', 'has_sufficient_data'),
        
        # Index for time-based queries
        Index('idx_created_at', 'created_at'),
    )
    
    def __repr__(self) -> str:
        return (
            f"<TrainingEvent("
            f"id={self.id}, "
            f"signal={self.signal_name}, "
            f"timeframe={self.timeframe}, "
            f"timestamp={self.timestamp}, "
            f"pnl={self.simulated_pnl}"
            f")>"
        )
    
    def to_dict(self) -> dict:
        """
        Convert to dictionary for JSON serialization
        
        Returns:
            dict: Training event data
        """
        return {
            'id': self.id,
            'block_name': self.block_name,
            'signal_name': self.signal_name,
            'timeframe': self.timeframe,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'entry_price': float(self.entry_price) if self.entry_price else None,
            'instrument': self.instrument,
            'max_favorable_move': float(self.max_favorable_move) if self.max_favorable_move else None,
            'max_adverse_move': float(self.max_adverse_move) if self.max_adverse_move else None,
            'final_move': float(self.final_move) if self.final_move else None,
            'volatility_atr': float(self.volatility_atr) if self.volatility_atr else None,
            'position_size': float(self.position_size) if self.position_size else None,
            'simulated_pnl': float(self.simulated_pnl) if self.simulated_pnl else None,
            'is_winning_trade': self.is_winning_trade,
            'price_impact_usd': float(self.price_impact_usd) if self.price_impact_usd else None,
            'forward_bars': self.forward_bars,
            'bars_to_max_favorable': self.bars_to_max_favorable,
            'bars_to_max_adverse': self.bars_to_max_adverse,
            'is_valid_signal': self.is_valid_signal,
            'has_sufficient_data': self.has_sufficient_data,
            'meets_min_criteria': self.meets_min_criteria,
            'sample_group': self.sample_group,
            'training_mode': self.training_mode,
            'analysis_version': self.analysis_version,
            'notes': self.notes
        }
    
    @classmethod
    def from_signal_event(cls, signal_event: 'SignalEvent', training_mode: str = 'testing') -> 'TrainingEvent':
        """
        Create TrainingEvent from SignalEvent (NautilusTrainingSystem output)
        
        Args:
            signal_event: SignalEvent from NautilusTrainingSystem
            training_mode: 'testing' or 'production'
        
        Returns:
            TrainingEvent: ORM object ready for database insert
        """
        return cls(
            block_name=signal_event.block_name,
            signal_name=signal_event.block_name,  # Can be refined with actual signal name
            timeframe='15m',  # Should come from signal_event metadata
            timestamp=signal_event.timestamp,
            entry_price=Decimal(str(signal_event.price.as_double())),
            instrument=str(signal_event.instrument_id),
            max_favorable_move=signal_event.max_favorable,
            max_adverse_move=signal_event.max_adverse,
            final_move=signal_event.final_move,
            volatility_atr=signal_event.volatility,
            position_size=Decimal(str(signal_event.position_size.as_double())),
            simulated_pnl=Decimal(str(signal_event.pnl.as_decimal())),
            is_winning_trade=(signal_event.pnl.as_decimal() > Decimal('0')),
            price_impact_usd=Decimal(str(signal_event.price_impact.as_decimal())),
            forward_bars=10,  # From config
            is_valid_signal=signal_event.is_valid,
            has_sufficient_data=signal_event.is_valid,
            meets_min_criteria=signal_event.is_valid,
            training_mode=training_mode,
            analysis_version='1.0'
        )


class TrainingEventQuery:
    """
    Helper class for common TrainingEvent queries
    
    Provides convenient methods for filtering and analyzing training events.
    """
    
    @staticmethod
    def get_by_signal(session, signal_name: str, timeframe: Optional[str] = None):
        """Get all events for a specific signal"""
        query = session.query(TrainingEvent).filter(
            TrainingEvent.signal_name == signal_name,
            TrainingEvent.is_valid_signal == True
        )
        
        if timeframe:
            query = query.filter(TrainingEvent.timeframe == timeframe)
        
        return query.all()
    
    @staticmethod
    def get_valid_events(session, min_date: Optional[datetime] = None):
        """Get all valid training events"""
        query = session.query(TrainingEvent).filter(
            TrainingEvent.is_valid_signal == True,
            TrainingEvent.has_sufficient_data == True
        )
        
        if min_date:
            query = query.filter(TrainingEvent.timestamp >= min_date)
        
        return query.all()
    
    @staticmethod
    def get_winning_rate(session, signal_name: str, timeframe: str) -> Decimal:
        """Calculate winning rate for a signal"""
        events = session.query(TrainingEvent).filter(
            TrainingEvent.signal_name == signal_name,
            TrainingEvent.timeframe == timeframe,
            TrainingEvent.is_valid_signal == True
        ).all()
        
        if not events:
            return Decimal('0')
        
        winning = sum(1 for e in events if e.is_winning_trade)
        return Decimal(str(winning)) / Decimal(str(len(events)))
    
    @staticmethod
    def get_statistics(session, signal_name: str, timeframe: str) -> dict:
        """Get comprehensive statistics for a signal"""
        events = session.query(TrainingEvent).filter(
            TrainingEvent.signal_name == signal_name,
            TrainingEvent.timeframe == timeframe,
            TrainingEvent.is_valid_signal == True
        ).all()
        
        if not events:
            return {
                'total_signals': 0,
                'win_rate': Decimal('0'),
                'avg_pnl': Decimal('0'),
                'avg_volatility': Decimal('0'),
                'avg_position_size': Decimal('0')
            }
        
        winning = sum(1 for e in events if e.is_winning_trade)
        total_pnl = sum(e.simulated_pnl for e in events if e.simulated_pnl)
        total_volatility = sum(e.volatility_atr for e in events if e.volatility_atr)
        total_position = sum(e.position_size for e in events if e.position_size)
        
        return {
            'total_signals': len(events),
            'win_rate': Decimal(str(winning)) / Decimal(str(len(events))),
            'avg_pnl': total_pnl / Decimal(str(len(events))) if total_pnl else Decimal('0'),
            'avg_volatility': total_volatility / Decimal(str(len(events))) if total_volatility else Decimal('0'),
            'avg_position_size': total_position / Decimal(str(len(events))) if total_position else Decimal('0')
        }
