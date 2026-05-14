"""
Advanced Data Loader for Building Blocks
Provides access to:
- Liquidations (parquet files)
- Order Book (depth/imbalance)
- Funding Rates
- Open Interest
- Trades (tick data)
"""

import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Optional, List
import warnings

import logging
logger = logging.getLogger(__name__)

warnings.filterwarnings('ignore')


class AdvancedDataLoader:
    """Load and process advanced market data"""
    
    def __init__(self, data_root: str = None):
        if data_root is None:
            # Auto-detect project root
            data_root = Path(__file__).parent.parent.parent / 'data' / 'raw'
        self.data_root = Path(data_root)
        
        # Cache for loaded data
        self._liquidations_cache = {}
        self._orderbook_cache = {}
        self._funding_cache = {}
        self._oi_cache = {}
        self._trades_cache = {}
    
    def load_liquidations(self, start_date: datetime, end_date: datetime) -> pd.DataFrame:
        """
        Load liquidation data for date range
        Returns: DataFrame with columns: timestamp, symbol, side, price, quantity
        """
        try:
            liq_path = self.data_root / 'liquidations'
            
            # Generate month list
            months = pd.date_range(
                start=start_date.replace(day=1),
                end=end_date,
                freq='MS'
            )
            
            dfs = []
            for month in months:
                file_name = f"BTC-USDT_liquidations_{month.strftime('%Y-%m')}.parquet"
                file_path = liq_path / file_name
                
                if file_path.exists():
                    try:
                        df = pd.read_parquet(file_path)
                        dfs.append(df)
                    except Exception as e:
                        logger.error(f"Error loading {file_name}: {e}")
                        continue
            
            if not dfs:
                return pd.DataFrame()
            
            # Combine all months
            combined = pd.concat(dfs, ignore_index=True)
            
            # Ensure timestamp column (try multiple possible names)
            if 'timestamp' in combined.columns:
                combined['timestamp'] = pd.to_datetime(combined['timestamp'])
            elif 'time' in combined.columns:
                combined['timestamp'] = pd.to_datetime(combined['time'])
            elif 'origin_time' in combined.columns:
                combined['timestamp'] = pd.to_datetime(combined['origin_time'])
            elif 'received_time' in combined.columns:
                combined['timestamp'] = pd.to_datetime(combined['received_time'])
            else:
                # No timestamp column found - return empty DataFrame
                logger.info(f"Warning: Liquidation data missing timestamp column. Available: {combined.columns.tolist()}")
                return pd.DataFrame()
            
            # Filter date range
            combined = combined[
                (combined['timestamp'] >= start_date) &
                (combined['timestamp'] <= end_date)
            ].copy()
            
            # Sort by timestamp
            combined = combined.sort_values('timestamp').reset_index(drop=True)
            
            return combined
            
        except Exception as e:
            logger.error(f"Error loading liquidations: {e}")
            return pd.DataFrame()
    
    def get_liquidation_levels(self, df_price: pd.DataFrame, lookback_bars: int = 100) -> Dict:
        """
        Get liquidation levels from price data timeframe
        Returns dict with liquidation clusters above/below current price
        """
        try:
            if len(df_price) < 10:
                return {'above': [], 'below': [], 'total_liq_volume': 0}
            
            # Get date range from price data
            start = df_price['timestamp'].iloc[max(0, len(df_price) - lookback_bars)]
            end = df_price['timestamp'].iloc[-1]
            
            # Load liquidations
            liq_df = self.load_liquidations(start, end)
            
            if len(liq_df) == 0:
                return {'above': [], 'below': [], 'total_liq_volume': 0}
            
            current_price = df_price['close'].iloc[-1]
            
            # Cluster liquidations by price level (round to nearest $50)
            liq_df['price_level'] = (liq_df['price'] / 50).round() * 50
            
            # Aggregate by level
            clusters = liq_df.groupby('price_level').agg({
                'quantity': 'sum',
                'price': 'count'
            }).reset_index()
            
            clusters.columns = ['price', 'volume', 'count']
            
            # Split above/below current price
            above = clusters[clusters['price'] > current_price].sort_values('price')
            below = clusters[clusters['price'] < current_price].sort_values('price', ascending=False)
            
            return {
                'above': above.to_dict('records'),
                'below': below.to_dict('records'),
                'total_liq_volume': liq_df['quantity'].sum(),
                'liq_count': len(liq_df)
            }
            
        except Exception as e:
            logger.error(f"Error getting liquidation levels: {e}")
            return {'above': [], 'below': [], 'total_liq_volume': 0}
    
    def detect_liquidation_spike(self, timestamp: datetime, window_minutes: int = 15) -> Dict:
        """
        Detect if there was a liquidation spike at given timestamp
        Returns: {has_spike, spike_volume, spike_side, confidence}
        """
        try:
            start = timestamp - timedelta(minutes=window_minutes)
            end = timestamp + timedelta(minutes=window_minutes)
            
            liq_df = self.load_liquidations(start, end)
            
            if len(liq_df) == 0:
                return {
                    'has_spike': False,
                    'spike_volume': 0,
                    'spike_side': 'NEUTRAL',
                    'confidence': 0
                }
            
            # Calculate volume in window
            window_volume = liq_df['quantity'].sum()
            
            # Get baseline (previous hour)
            baseline_start = start - timedelta(hours=1)
            baseline_df = self.load_liquidations(baseline_start, start)
            
            if len(baseline_df) > 0:
                baseline_volume = baseline_df['quantity'].sum() / 4  # Per 15 min
            else:
                baseline_volume = window_volume * 0.5  # Conservative estimate
            
            # Spike detection
            if baseline_volume > 0:
                spike_ratio = window_volume / baseline_volume
            else:
                spike_ratio = 1.0
            
            has_spike = spike_ratio > 2.0  # 2x baseline = spike
            
            # Determine side
            if 'side' in liq_df.columns:
                long_liq = liq_df[liq_df['side'] == 'LONG']['quantity'].sum()
                short_liq = liq_df[liq_df['side'] == 'SHORT']['quantity'].sum()
                
                if long_liq > short_liq * 1.5:
                    spike_side = 'LONG'
                elif short_liq > long_liq * 1.5:
                    spike_side = 'SHORT'
                else:
                    spike_side = 'MIXED'
            else:
                spike_side = 'UNKNOWN'
            
            # Confidence based on spike magnitude
            confidence = min(100, int(spike_ratio * 30))
            
            return {
                'has_spike': has_spike,
                'spike_volume': window_volume,
                'spike_side': spike_side,
                'confidence': confidence,
                'spike_ratio': spike_ratio
            }
            
        except Exception as e:
            logger.error(f"Error detecting liquidation spike: {e}")
            return {
                'has_spike': False,
                'spike_volume': 0,
                'spike_side': 'NEUTRAL',
                'confidence': 0
            }
    
    def load_orderbook_snapshot(self, timestamp: datetime) -> Optional[Dict]:
        """
        Load order book snapshot closest to timestamp
        Returns: {bids: [(price, size), ...], asks: [(price, size), ...]}
        """
        try:
            ob_path = self.data_root / 'orderbook'
            
            # Try to find closest snapshot
            # This is a placeholder - actual implementation depends on your orderbook format
            # For now, return None to indicate not available
            return None
            
        except Exception as e:
            logger.error(f"Error loading orderbook: {e}")
            return None
    
    def estimate_order_book_from_volume(self, df: pd.DataFrame, window: int = 20) -> Dict:
        """
        Estimate order book imbalance from volume patterns
        Fallback when actual orderbook not available
        """
        if len(df) < window or 'volume' not in df.columns:
            return {
                'bid_strength': 50,
                'ask_strength': 50,
                'imbalance_ratio': 1.0,
                'estimated': True
            }
        
        recent = df.iloc[-window:]
        
        # Bullish bars = buy pressure
        bullish_volume = recent[recent['close'] > recent['open']]['volume'].sum()
        bearish_volume = recent[recent['close'] < recent['open']]['volume'].sum()
        
        total = bullish_volume + bearish_volume
        if total > 0:
            bid_strength = int((bullish_volume / total) * 100)
            ask_strength = 100 - bid_strength
            imbalance_ratio = bullish_volume / max(1, bearish_volume)
        else:
            bid_strength = 50
            ask_strength = 50
            imbalance_ratio = 1.0
        
        return {
            'bid_strength': bid_strength,
            'ask_strength': ask_strength,
            'imbalance_ratio': imbalance_ratio,
            'estimated': True
        }
    
    def load_funding_rate(self, timestamp: datetime) -> Optional[float]:
        """
        Load funding rate at timestamp
        Returns: funding_rate (annualized %)
        """
        try:
            funding_path = self.data_root / 'funding'
            # Placeholder - actual implementation depends on your funding format
            return None
        except Exception as e:
            logger.error(f"Error loading funding: {e}")
            return None
    
    def load_open_interest(self, start_date: datetime, end_date: datetime) -> pd.DataFrame:
        """
        Load open interest data
        Returns: DataFrame with timestamp and OI value
        """
        try:
            oi_path = self.data_root / 'open_interest'
            # Placeholder - actual implementation depends on your OI format
            return pd.DataFrame()
        except Exception as e:
            logger.error(f"Error loading open interest: {e}")
            return pd.DataFrame()


# Global instance for easy import
advanced_data = AdvancedDataLoader()


if __name__ == "__main__":
    # Test the loader
    logger.info("Testing Advanced Data Loader...")
    
    loader = AdvancedDataLoader()
    
    # Test liquidations
    end = datetime.now()
    start = end - timedelta(days=7)
    
    logger.info(f"\nLoading liquidations from {start} to {end}...")
    liq_df = loader.load_liquidations(start, end)
    logger.info(f"Loaded {len(liq_df)} liquidation records")
    
    if len(liq_df) > 0:
        logger.info(f"Columns: {liq_df.columns.tolist()}")
        logger.info(f"Total liquidation volume: {liq_df['quantity'].sum():,.2f}")
        logger.info(f"\nSample records:")
        logger.info(liq_df.head())
    
    logger.info("\n" + "="*80)
    logger.info("Advanced Data Loader Ready!")
    logger.info("="*80)
