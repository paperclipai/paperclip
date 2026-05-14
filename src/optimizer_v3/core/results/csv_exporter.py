"""
CSV Export System
Task 1.3.8: Export optimization results to CSV format

Features:
- Comprehensive results export
- Trade-level detail export
- Configuration export
- Metrics export
- Customizable columns
"""

from decimal import Decimal
from typing import List, Dict, Optional, Set
from datetime import datetime
import csv
import io
from pathlib import Path
from nautilus_trader.model.objects import Money, Quantity, Price
from nautilus_trader.model.currencies import USD
from dotenv import load_dotenv
import os


class CSVExporter:
    """
    Export optimization results to CSV format
    
    Provides flexible CSV export with column customization
    """
    
    def __init__(self):
        """Initialize CSV exporter with configuration"""
        load_dotenv()
        
        self.config = {
            'decimal_places': int(os.getenv('EXPORT_DECIMAL_PLACES', '8')),
            'include_timestamps': os.getenv('EXPORT_INCLUDE_TIMESTAMPS', 'true').lower() == 'true',
            'batch_size': int(os.getenv('EXPORT_BATCH_SIZE', '1000')),
            'max_rows': int(os.getenv('EXPORT_MAX_ROWS', '1000000'))
        }
    
    def export_results_summary(self,
                              results: List[Dict],
                              filepath: str,
                              columns: Optional[List[str]] = None) -> Dict:
        """
        Export optimization results summary to CSV
        
        Args:
            results: List of ranked results
            filepath: Output CSV file path
            columns: Optional list of columns to include
        
        Returns:
            Export statistics
        """
        if not results:
            return {'error': 'No results to export', 'rows_exported': 0}
        
        # Default columns if not specified
        if columns is None:
            columns = self._get_default_summary_columns()
        
        # Prepare rows
        rows = []
        for result in results:
            row = self._extract_summary_row(result, columns)
            rows.append(row)
        
        # Write to CSV
        stats = self._write_csv(filepath, rows, columns)
        
        return stats
    
    def export_trades_detail(self,
                            trades: List[Dict],
                            filepath: str,
                            columns: Optional[List[str]] = None) -> Dict:
        """
        Export trade-level details to CSV
        
        Args:
            trades: List of trades
            filepath: Output CSV file path
            columns: Optional list of columns to include
        
        Returns:
            Export statistics
        """
        if not trades:
            return {'error': 'No trades to export', 'rows_exported': 0}
        
        # Default columns if not specified
        if columns is None:
            columns = self._get_default_trade_columns()
        
        # Prepare rows
        rows = []
        for trade in trades:
            row = self._extract_trade_row(trade, columns)
            rows.append(row)
        
        # Write to CSV
        stats = self._write_csv(filepath, rows, columns)
        
        return stats
    
    def export_metrics_comparison(self,
                                 results: List[Dict],
                                 filepath: str,
                                 metrics: Optional[List[str]] = None) -> Dict:
        """
        Export metrics comparison to CSV
        
        Args:
            results: List of results with metrics
            filepath: Output CSV file path
            metrics: Optional list of metrics to include
        
        Returns:
            Export statistics
        """
        if not results:
            return {'error': 'No results to export', 'rows_exported': 0}
        
        # Default metrics if not specified
        if metrics is None:
            metrics = self._get_default_metrics()
        
        # Prepare rows
        rows = []
        for result in results:
            row = self._extract_metrics_row(result, metrics)
            rows.append(row)
        
        # Prepare columns (config_id + metrics)
        columns = ['config_id'] + metrics
        
        # Write to CSV
        stats = self._write_csv(filepath, rows, columns)
        
        return stats
    
    def export_configurations(self,
                            configs: List[Dict],
                            filepath: str,
                            config_ids: Optional[List[str]] = None) -> Dict:
        """
        Export configurations to CSV
        
        Args:
            configs: List of configurations
            filepath: Output CSV file path
            config_ids: Optional list of config IDs
        
        Returns:
            Export statistics
        """
        if not configs:
            return {'error': 'No configs to export', 'rows_exported': 0}
        
        # Use indices if no IDs provided
        if not config_ids:
            config_ids = [f'Config_{i}' for i in range(len(configs))]
        
        # Get all unique parameter keys
        all_keys = set()
        for config in configs:
            all_keys.update(self._flatten_dict(config).keys())
        
        columns = ['config_id'] + sorted(all_keys)
        
        # Prepare rows
        rows = []
        for config_id, config in zip(config_ids, configs):
            flat_config = self._flatten_dict(config)
            row = {'config_id': config_id}
            row.update(flat_config)
            rows.append(row)
        
        # Write to CSV
        stats = self._write_csv(filepath, rows, columns)
        
        return stats
    
    # ==================== Column Definitions ====================
    
    def _get_default_summary_columns(self) -> List[str]:
        """Get default columns for summary export - Sprint 1.8 Task 1.8.67"""
        return [
            'rank',
            'config_id',
            'composite_score',
            'sharpe_ratio',
            'sortino_ratio',
            'calmar_ratio',
            'win_rate',
            'profit_factor',
            'max_drawdown_pct',
            'total_trades',
            'total_pnl',
            'annualized_return',
            'capital_efficiency',
            # Sprint 1.8 Task 1.8.67: Exit condition columns
            'exit_condition_triggers',
            'exit_condition_pnl',
            'partial_exit_count'
        ]
    
    def _get_default_trade_columns(self) -> List[str]:
        """Get default columns for trade export - Sprint 1.8 Task 1.8.68"""
        columns = [
            'trade_id',
            'entry_time',
            'exit_time',
            'side',
            'quantity',
            'entry_price',
            'exit_price',
            'pnl',
            'return_pct',
            'duration_hours',
            'win_loss',
            # Sprint 1.8 Task 1.8.68: Exit condition columns
            'exit_type',  # TP1/TP2/TP3/SL/EXIT_CONDITION
            'exit_condition_name',  # if applicable
            'partial_exit_percentage'  # if partial exit
        ]
        
        if self.config['include_timestamps']:
            columns.extend(['entry_timestamp', 'exit_timestamp'])
        
        return columns
    
    def _get_default_metrics(self) -> List[str]:
        """Get default metrics for comparison export"""
        return [
            'sharpe_ratio',
            'sortino_ratio',
            'calmar_ratio',
            'win_rate',
            'profit_factor',
            'max_drawdown_pct',
            'total_return',
            'volatility',
            'total_trades'
        ]
    
    # ==================== Row Extraction ====================
    
    def _extract_summary_row(self, result: Dict, columns: List[str]) -> Dict:
        """Extract summary row from result"""
        row = {}
        
        inst_metrics = result.get('institutional_metrics', {})
        risk_metrics = result.get('risk_metrics', {})
        
        for col in columns:
            if col == 'rank':
                row[col] = result.get('rank', '')
            elif col == 'config_id':
                row[col] = result.get('config_id', 'Unknown')
            elif col == 'composite_score':
                row[col] = self._format_value(result.get('composite_score', Decimal('0')))
            elif col == 'sharpe_ratio':
                row[col] = self._format_value(inst_metrics.get('sharpe_ratio', Decimal('0')))
            elif col == 'sortino_ratio':
                row[col] = self._format_value(inst_metrics.get('sortino_ratio', Decimal('0')))
            elif col == 'calmar_ratio':
                row[col] = self._format_value(inst_metrics.get('calmar_ratio', Decimal('0')))
            elif col == 'win_rate':
                row[col] = self._format_value(inst_metrics.get('win_rate', Decimal('0')))
            elif col == 'profit_factor':
                row[col] = self._format_value(inst_metrics.get('profit_factor', Decimal('0')))
            elif col == 'max_drawdown_pct':
                row[col] = self._format_value(inst_metrics.get('max_drawdown_percent', Decimal('0')))
            elif col == 'total_trades':
                row[col] = inst_metrics.get('total_trades', 0)
            elif col == 'total_pnl':
                total_pnl = inst_metrics.get('total_pnl', Money('0', USD))
                row[col] = self._format_money(total_pnl)
            elif col == 'annualized_return':
                row[col] = self._format_value(inst_metrics.get('annualized_return', Decimal('0')))
            elif col == 'capital_efficiency':
                row[col] = self._format_value(inst_metrics.get('capital_efficiency', Decimal('0')))
            else:
                # Try to find in nested dicts
                row[col] = self._find_nested_value(result, col)
        
        return row
    
    def _extract_trade_row(self, trade: Dict, columns: List[str]) -> Dict:
        """Extract trade row from trade dict"""
        row = {}
        
        for col in columns:
            if col == 'trade_id':
                trade_id = trade.get('trade_id', '')
                row[col] = str(trade_id) if hasattr(trade_id, 'to_string') else str(trade_id)
            elif col == 'entry_time':
                entry_time = trade.get('entry_time', '')
                row[col] = entry_time.strftime('%Y-%m-%d %H:%M:%S') if isinstance(entry_time, datetime) else str(entry_time)
            elif col == 'exit_time':
                exit_time = trade.get('exit_time', '')
                row[col] = exit_time.strftime('%Y-%m-%d %H:%M:%S') if isinstance(exit_time, datetime) else str(exit_time)
            elif col == 'side':
                row[col] = trade.get('side', '')
            elif col == 'quantity':
                quantity = trade.get('quantity', Quantity.from_str('0'))
                row[col] = self._format_nautilus_type(quantity)
            elif col == 'entry_price':
                entry_price = trade.get('entry_price', Price.from_str('0'))
                row[col] = self._format_nautilus_type(entry_price)
            elif col == 'exit_price':
                exit_price = trade.get('exit_price', Price.from_str('0'))
                row[col] = self._format_nautilus_type(exit_price)
            elif col == 'pnl':
                pnl = trade.get('pnl', Money('0', USD))
                row[col] = self._format_money(pnl)
            elif col == 'return_pct':
                # Calculate return percentage
                pnl = trade.get('pnl', Money('0', USD))
                capital = trade.get('capital_start', Money('10000', USD))
                pnl_val = self._money_to_decimal(pnl)
                cap_val = self._money_to_decimal(capital)
                return_pct = (pnl_val / cap_val * Decimal('100')) if cap_val > 0 else Decimal('0')
                row[col] = self._format_value(return_pct)
            elif col == 'duration_hours':
                entry_time = trade.get('entry_time')
                exit_time = trade.get('exit_time')
                if entry_time and exit_time:
                    duration = (exit_time - entry_time).total_seconds() / 3600
                    row[col] = f"{duration:.2f}"
                else:
                    row[col] = ''
            elif col == 'win_loss':
                pnl = trade.get('pnl', Money('0', USD))
                pnl_val = self._money_to_decimal(pnl)
                row[col] = 'WIN' if pnl_val > 0 else 'LOSS'
            elif col == 'entry_timestamp':
                entry_time = trade.get('entry_time', '')
                row[col] = entry_time.timestamp() if isinstance(entry_time, datetime) else ''
            elif col == 'exit_timestamp':
                exit_time = trade.get('exit_time', '')
                row[col] = exit_time.timestamp() if isinstance(exit_time, datetime) else ''
            # Sprint 1.8 Task 1.8.68: Exit condition columns
            elif col == 'exit_type':
                row[col] = trade.get('exit_type', 'TP1')  # TP1/TP2/TP3/SL/EXIT_CONDITION
            elif col == 'exit_condition_name':
                row[col] = trade.get('exit_condition_name', '')  # Only if exit_type = EXIT_CONDITION
            elif col == 'partial_exit_percentage':
                exit_pct = trade.get('partial_exit_percentage', '')
                row[col] = self._format_value(exit_pct) if exit_pct else ''
            else:
                row[col] = trade.get(col, '')
        
        return row
    
    def _extract_metrics_row(self, result: Dict, metrics: List[str]) -> Dict:
        """Extract metrics row from result"""
        row = {'config_id': result.get('config_id', 'Unknown')}
        
        inst_metrics = result.get('institutional_metrics', {})
        
        for metric in metrics:
            value = inst_metrics.get(metric, '')
            row[metric] = self._format_value(value)
        
        return row
    
    # ==================== CSV Writing ====================
    
    def _write_csv(self, filepath: str, rows: List[Dict], columns: List[str]) -> Dict:
        """Write rows to CSV file"""
        try:
            # Create parent directories if needed
            Path(filepath).parent.mkdir(parents=True, exist_ok=True)
            
            # Write CSV
            with open(filepath, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=columns)
                writer.writeheader()
                
                # Limit rows if needed
                rows_to_write = rows[:self.config['max_rows']]
                writer.writerows(rows_to_write)
            
            return {
                'success': True,
                'filepath': filepath,
                'rows_exported': len(rows_to_write),
                'columns': len(columns),
                'truncated': len(rows) > len(rows_to_write)
            }
        
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'rows_exported': 0
            }
    
    def export_to_string(self, rows: List[Dict], columns: List[str]) -> str:
        """Export to CSV string (for in-memory processing)"""
        output = io.StringIO()
        
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
        
        return output.getvalue()
    
    # ==================== Formatting ====================
    
    def _format_value(self, value: any) -> str:
        """Format value for CSV"""
        if value is None or value == '':
            return ''
        
        if isinstance(value, Decimal):
            # Format decimal with specified precision
            return f"{value:.{self.config['decimal_places']}f}"
        
        if isinstance(value, float):
            return f"{value:.{self.config['decimal_places']}f}"
        
        if isinstance(value, (Money, Quantity, Price)):
            return self._format_nautilus_type(value)
        
        return str(value)
    
    def _format_money(self, money: Money) -> str:
        """Format Money type"""
        if isinstance(money, Money):
            value = money.as_decimal()
            return f"{value:.{self.config['decimal_places']}f}"
        return str(money)
    
    def _format_nautilus_type(self, value: any) -> str:
        """Format NautilusTrader types"""
        if isinstance(value, (Money, Quantity, Price)):
            decimal_value = value.as_decimal()
            return f"{decimal_value:.{self.config['decimal_places']}f}"
        return str(value)
    
    def _money_to_decimal(self, money: Money) -> Decimal:
        """Convert Money to Decimal"""
        if isinstance(money, Money):
            return Decimal(str(money.as_decimal()))
        return Decimal(str(money))
    
    def _find_nested_value(self, data: Dict, key: str) -> str:
        """Find value in nested dictionary"""
        if key in data:
            return self._format_value(data[key])
        
        # Search in nested dicts
        for value in data.values():
            if isinstance(value, dict):
                if key in value:
                    return self._format_value(value[key])
        
        return ''
    
    def _flatten_dict(self, d: Dict, parent_key: str = '', sep: str = '_') -> Dict:
        """Flatten nested dictionary"""
        items = []
        
        for k, v in d.items():
            new_key = f"{parent_key}{sep}{k}" if parent_key else k
            
            if isinstance(v, dict):
                items.extend(self._flatten_dict(v, new_key, sep=sep).items())
            else:
                items.append((new_key, self._format_value(v)))
        
        return dict(items)
    
    # ==================== Batch Export ====================
    
    def export_batched(self,
                      results: List[Dict],
                      base_filepath: str,
                      batch_size: Optional[int] = None) -> Dict:
        """
        Export results in batches
        
        Useful for very large result sets
        """
        if batch_size is None:
            batch_size = self.config['batch_size']
        
        n_batches = (len(results) + batch_size - 1) // batch_size
        
        batch_stats = []
        
        for i in range(n_batches):
            start_idx = i * batch_size
            end_idx = min((i + 1) * batch_size, len(results))
            batch = results[start_idx:end_idx]
            
            # Create batch filename
            filepath = f"{base_filepath}_batch_{i+1}.csv"
            
            # Export batch
            stats = self.export_results_summary(batch, filepath)
            batch_stats.append({
                'batch': i + 1,
                'filepath': filepath,
                **stats
            })
        
        return {
            'total_batches': n_batches,
            'total_rows': len(results),
            'batch_size': batch_size,
            'batches': batch_stats
        }
