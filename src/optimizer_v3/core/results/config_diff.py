"""
Configuration Difference Highlighter
Task 1.3.7: Identify and highlight configuration differences between results

Compares:
- Strategy parameters
- Risk management settings
- Signal configurations
- Entry/Exit rules
"""

from decimal import Decimal
from typing import List, Dict, Any, Optional, Set
from nautilus_trader.model.objects import Money, Quantity, Price
import json


class ConfigDiffHighlighter:
    """
    Highlight differences between optimization configurations
    
    Identifies which parameters differ between results
    """
    
    def __init__(self):
        """Initialize config diff highlighter"""
        self.ignore_keys = {'timestamp', 'run_id', 'session_id', 'result_id'}
    
    def compare_two_configs(self,
                          config_a: Dict,
                          config_b: Dict,
                          highlight_type: str = 'all') -> Dict:
        """
        Compare two configurations and highlight differences
        
        Args:
            config_a: First configuration
            config_b: Second configuration
            highlight_type: 'all', 'changed', 'added', 'removed'
        
        Returns:
            Dictionary with comparison results
        """
        # Normalize configs
        norm_a = self._normalize_config(config_a)
        norm_b = self._normalize_config(config_b)
        
        # Find differences
        differences = self._find_differences(norm_a, norm_b)
        
        # Categorize differences
        changed = differences['changed']
        added = differences['added_in_b']
        removed = differences['removed_from_a']
        same = differences['same']
        
        # Filter based on highlight type
        if highlight_type == 'changed':
            result_diffs = changed
        elif highlight_type == 'added':
            result_diffs = added
        elif highlight_type == 'removed':
            result_diffs = removed
        else:  # 'all'
            result_diffs = {**changed, **added, **removed}
        
        return {
            'total_parameters': len(norm_a) + len(norm_b),
            'same_count': len(same),
            'changed_count': len(changed),
            'added_count': len(added),
            'removed_count': len(removed),
            'differences': result_diffs,
            'same_parameters': same,
            'summary': self._create_summary(changed, added, removed)
        }
    
    def compare_multiple_configs(self,
                                configs: List[Dict],
                                config_ids: Optional[List[str]] = None) -> Dict:
        """
        Compare multiple configurations
        
        Args:
            configs: List of configurations
            config_ids: Optional list of config identifiers
        
        Returns:
            Dictionary with multi-config comparison
        """
        if len(configs) < 2:
            return {
                'error': 'Need at least 2 configs for comparison',
                'n_configs': len(configs)
            }
        
        # Use indices if no IDs provided
        if not config_ids:
            config_ids = [f'Config_{i}' for i in range(len(configs))]
        
        # Normalize all configs
        norm_configs = [self._normalize_config(c) for c in configs]
        
        # Find all unique keys
        all_keys = set()
        for config in norm_configs:
            all_keys.update(config.keys())
        
        # Remove ignored keys
        all_keys -= self.ignore_keys
        
        # Build comparison matrix
        comparison_matrix = {}
        
        for key in all_keys:
            values = []
            for i, config in enumerate(norm_configs):
                value = config.get(key, '<not set>')
                values.append({
                    'config_id': config_ids[i],
                    'value': value
                })
            
            # Check if all values are the same
            unique_values = set(str(v['value']) for v in values)
            is_same = len(unique_values) == 1
            
            comparison_matrix[key] = {
                'values': values,
                'is_same': is_same,
                'unique_count': len(unique_values),
                'variation': 'uniform' if is_same else 'varies'
            }
        
        # Find parameters that vary
        varying_params = {
            k: v for k, v in comparison_matrix.items()
            if not v['is_same']
        }
        
        # Find uniform parameters
        uniform_params = {
            k: v for k, v in comparison_matrix.items()
            if v['is_same']
        }
        
        return {
            'n_configs': len(configs),
            'config_ids': config_ids,
            'total_parameters': len(all_keys),
            'varying_parameters': len(varying_params),
            'uniform_parameters': len(uniform_params),
            'comparison_matrix': comparison_matrix,
            'varying_params_only': varying_params,
            'uniform_params_only': uniform_params,
            'summary': self._create_multi_config_summary(varying_params, uniform_params)
        }
    
    def highlight_winning_differences(self,
                                     winner_config: Dict,
                                     loser_configs: List[Dict],
                                     performance_metric: str = 'sharpe_ratio') -> Dict:
        """
        Highlight what's different about the winning configuration
        
        Args:
            winner_config: Best performing configuration
            loser_configs: Other configurations
            performance_metric: Metric used to determine winner
        
        Returns:
            Analysis of winning characteristics
        """
        # Find common differences
        winner_norm = self._normalize_config(winner_config)
        
        unique_to_winner = {}
        common_across_losers = {}
        
        for key in winner_norm.keys():
            if key in self.ignore_keys:
                continue
            
            winner_value = winner_norm[key]
            
            # Check if this value differs from all losers
            loser_values = []
            for loser in loser_configs:
                loser_norm = self._normalize_config(loser)
                if key in loser_norm:
                    loser_values.append(loser_norm[key])
            
            if loser_values:
                # Check if winner value is unique
                if all(str(winner_value) != str(lv) for lv in loser_values):
                    unique_to_winner[key] = {
                        'winner_value': winner_value,
                        'loser_values': loser_values,
                        'potential_edge': True
                    }
                
                # Check if all losers have same value (different from winner)
                if len(set(str(lv) for lv in loser_values)) == 1:
                    if str(winner_value) != str(loser_values[0]):
                        common_across_losers[key] = {
                            'winner_value': winner_value,
                            'loser_common_value': loser_values[0],
                            'strong_indicator': True
                        }
        
        return {
            'performance_metric': performance_metric,
            'unique_to_winner_count': len(unique_to_winner),
            'common_loser_pattern_count': len(common_across_losers),
            'unique_to_winner': unique_to_winner,
            'common_loser_patterns': common_across_losers,
            'key_differentiators': list(common_across_losers.keys()),
            'recommendations': self._generate_recommendations(unique_to_winner, common_across_losers)
        }
    
    # ==================== Difference Detection ====================
    
    def _find_differences(self, config_a: Dict, config_b: Dict) -> Dict:
        """Find all differences between two configs"""
        changed = {}
        added_in_b = {}
        removed_from_a = {}
        same = {}
        
        # Keys in both configs
        common_keys = set(config_a.keys()) & set(config_b.keys())
        common_keys -= self.ignore_keys
        
        for key in common_keys:
            val_a = config_a[key]
            val_b = config_b[key]
            
            if self._values_equal(val_a, val_b):
                same[key] = val_a
            else:
                changed[key] = {
                    'config_a': val_a,
                    'config_b': val_b,
                    'type': type(val_a).__name__,
                    'change_type': self._classify_change(val_a, val_b)
                }
        
        # Keys only in A
        only_in_a = set(config_a.keys()) - set(config_b.keys())
        only_in_a -= self.ignore_keys
        for key in only_in_a:
            removed_from_a[key] = {
                'value': config_a[key],
                'type': type(config_a[key]).__name__
            }
        
        # Keys only in B
        only_in_b = set(config_b.keys()) - set(config_a.keys())
        only_in_b -= self.ignore_keys
        for key in only_in_b:
            added_in_b[key] = {
                'value': config_b[key],
                'type': type(config_b[key]).__name__
            }
        
        return {
            'changed': changed,
            'added_in_b': added_in_b,
            'removed_from_a': removed_from_a,
            'same': same
        }
    
    def _values_equal(self, val_a: Any, val_b: Any) -> bool:
        """Check if two values are equal (handling NautilusTrader types)"""
        # Handle NautilusTrader types
        if isinstance(val_a, (Money, Quantity, Price)):
            val_a = str(val_a)
        if isinstance(val_b, (Money, Quantity, Price)):
            val_b = str(val_b)
        
        # Handle Decimal
        if isinstance(val_a, Decimal) and isinstance(val_b, Decimal):
            return abs(val_a - val_b) < Decimal('0.0000001')
        
        # Handle floats with tolerance
        if isinstance(val_a, float) and isinstance(val_b, float):
            return abs(val_a - val_b) < 1e-6
        
        # Handle dicts recursively
        if isinstance(val_a, dict) and isinstance(val_b, dict):
            if set(val_a.keys()) != set(val_b.keys()):
                return False
            return all(self._values_equal(val_a[k], val_b[k]) for k in val_a.keys())
        
        # Handle lists
        if isinstance(val_a, list) and isinstance(val_b, list):
            if len(val_a) != len(val_b):
                return False
            return all(self._values_equal(a, b) for a, b in zip(val_a, val_b))
        
        # Default comparison
        return str(val_a) == str(val_b)
    
    def _classify_change(self, val_a: Any, val_b: Any) -> str:
        """Classify the type of change"""
        # Type change
        if type(val_a) != type(val_b):
            return 'type_change'
        
        # Numeric changes
        if isinstance(val_a, (int, float, Decimal)):
            try:
                diff_pct = abs(float(val_b) - float(val_a)) / abs(float(val_a)) * 100
                if diff_pct > 50:
                    return 'major_change'
                elif diff_pct > 10:
                    return 'moderate_change'
                else:
                    return 'minor_change'
            except (ValueError, ZeroDivisionError):
                return 'value_change'
        
        # String/enum changes
        return 'value_change'
    
    # ==================== Normalization ====================
    
    def _normalize_config(self, config: Dict) -> Dict:
        """Normalize configuration for comparison"""
        normalized = {}
        
        for key, value in config.items():
            # Convert NautilusTrader types to strings
            if isinstance(value, (Money, Quantity, Price)):
                normalized[key] = str(value)
            # Convert Decimals to strings
            elif isinstance(value, Decimal):
                normalized[key] = str(value)
            # Keep dicts as-is (will be compared recursively)
            elif isinstance(value, dict):
                normalized[key] = self._normalize_config(value)
            # Keep lists as-is
            elif isinstance(value, list):
                normalized[key] = [
                    self._normalize_value(v) for v in value
                ]
            else:
                normalized[key] = value
        
        return normalized
    
    def _normalize_value(self, value: Any) -> Any:
        """Normalize a single value"""
        if isinstance(value, (Money, Quantity, Price, Decimal)):
            return str(value)
        elif isinstance(value, dict):
            return self._normalize_config(value)
        elif isinstance(value, list):
            return [self._normalize_value(v) for v in value]
        return value
    
    # ==================== Summary Generation ====================
    
    def _create_summary(self,
                       changed: Dict,
                       added: Dict,
                       removed: Dict) -> str:
        """Create human-readable summary"""
        summary_parts = []
        
        if changed:
            summary_parts.append(f"{len(changed)} parameter(s) changed")
        if added:
            summary_parts.append(f"{len(added)} parameter(s) added")
        if removed:
            summary_parts.append(f"{len(removed)} parameter(s) removed")
        
        if not summary_parts:
            return "Configurations are identical"
        
        return ", ".join(summary_parts)
    
    def _create_multi_config_summary(self,
                                    varying: Dict,
                                    uniform: Dict) -> str:
        """Create summary for multiple configs"""
        total = len(varying) + len(uniform)
        
        if not varying:
            return "All configurations are identical"
        
        vary_pct = (len(varying) / total * 100) if total > 0 else 0
        
        return f"{len(varying)} of {total} parameters vary ({vary_pct:.1f}%)"
    
    def _generate_recommendations(self,
                                 unique: Dict,
                                 common_losers: Dict) -> List[str]:
        """Generate recommendations based on winning differences"""
        recommendations = []
        
        if common_losers:
            recommendations.append(
                f"Focus on these {len(common_losers)} parameter(s) that differ consistently: "
                f"{', '.join(list(common_losers.keys())[:5])}"
            )
        
        if unique:
            recommendations.append(
                f"Winner has unique values for {len(unique)} parameter(s) - "
                "these may provide edge"
            )
        
        if not recommendations:
            recommendations.append(
                "No clear distinguishing parameters found - "
                "differences may be in parameter combinations"
            )
        
        return recommendations
    
    # ==================== Export ====================
    
    def export_diff_report(self,
                          comparison: Dict,
                          format: str = 'json') -> str:
        """
        Export comparison report
        
        Args:
            comparison: Comparison dictionary from compare methods
            format: 'json', 'text', or 'markdown'
        
        Returns:
            Formatted report string
        """
        if format == 'json':
            return json.dumps(comparison, indent=2, default=str)
        
        elif format == 'markdown':
            return self._format_markdown_report(comparison)
        
        else:  # text
            return self._format_text_report(comparison)
    
    def _format_markdown_report(self, comparison: Dict) -> str:
        """Format comparison as Markdown"""
        lines = ["# Configuration Comparison Report\n"]
        
        lines.append(f"**Summary**: {comparison.get('summary', 'N/A')}\n")
        
        if 'differences' in comparison:
            lines.append("## Differences\n")
            for key, diff in comparison['differences'].items():
                if isinstance(diff, dict) and 'config_a' in diff:
                    lines.append(f"- **{key}**:")
                    lines.append(f"  - Config A: `{diff['config_a']}`")
                    lines.append(f"  - Config B: `{diff['config_b']}`")
                    lines.append(f"  - Change Type: {diff.get('change_type', 'N/A')}\n")
        
        return "\n".join(lines)
    
    def _format_text_report(self, comparison: Dict) -> str:
        """Format comparison as plain text"""
        lines = ["Configuration Comparison Report", "=" * 50, ""]
        
        lines.append(f"Summary: {comparison.get('summary', 'N/A')}")
        lines.append("")
        
        if 'differences' in comparison:
            lines.append("Differences:")
            lines.append("-" * 50)
            for key, diff in comparison['differences'].items():
                if isinstance(diff, dict) and 'config_a' in diff:
                    lines.append(f"\n{key}:")
                    lines.append(f"  Config A: {diff['config_a']}")
                    lines.append(f"  Config B: {diff['config_b']}")
                    lines.append(f"  Change: {diff.get('change_type', 'N/A')}")
        
        return "\n".join(lines)
