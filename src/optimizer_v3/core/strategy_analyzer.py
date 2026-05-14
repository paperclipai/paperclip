"""
Optimizer V3 - Strategy Analyzer
Extracts optimizable parameters from strategies (timing, recheck, risk).
"""

from typing import Dict, List, Any, Optional, Tuple
from decimal import Decimal
from copy import deepcopy

from src.optimizer_v3.core.logger import OptimizerLogger
from src.optimizer_v3.core.validator import DataValidator, ValidationError
from src.optimizer_v3.core.dependency_graph import DependencyGraph

import logging
logger = logging.getLogger(__name__)



class StrategyAnalyzer:
    """
    Analyze strategies and extract optimizable parameters.
    
    Features:
    - Extract timing parameters
    - Extract recheck parameters
    - Extract risk parameters
    - Generate optimization ranges
    - Build dependency graphs
    - Validate parameter combinations
    
    Args:
        logger: OptimizerLogger instance for logging
        validator: DataValidator instance for validation
    """
    
    def __init__(
        self,
        logger: Optional[OptimizerLogger] = None,
        validator: Optional[DataValidator] = None
    ):
        self.logger = logger or OptimizerLogger('strategy_analyzer')
        self.validator = validator or DataValidator(self.logger)
        self.dependency_graph = DependencyGraph(self.logger, self.validator)
        
        # Default optimization ranges
        self.default_ranges = {
            'timing': {
                'min_multiplier': Decimal('0.5'),
                'max_multiplier': Decimal('2.0'),
                'step': 1
            },
            'recheck': {
                'min_bars': 1,
                'max_bars': 20,
                'step': 1
            },
            'risk': {
                'min_risk_reward': Decimal('1.5'),
                'max_risk_reward': Decimal('3.0'),
                'risk_reward_step': Decimal('0.1'),
                'min_risk_percent': Decimal('0.5'),
                'max_risk_percent': Decimal('2.0'),
                'risk_percent_step': Decimal('0.1')
            }
        }
    
    def analyze_strategy(self, strategy: Dict[str, Any]) -> Dict[str, Any]:
        """
        Complete strategy analysis.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Returns:
            Analysis results dictionary containing:
            - timing_parameters
            - recheck_parameters
            - risk_parameters
            - dependency_graph
            - optimization_space
        """
        self.logger.info(
            "Analyzing strategy",
            strategy_name=strategy.get('name', 'unknown')
        )
        
        # Validate strategy
        self.validator.validate_strategy(strategy)
        
        # Build dependency graph
        self.dependency_graph.build_from_strategy(strategy)
        
        # Extract parameters
        timing_params = self.extract_timing_parameters(strategy)
        recheck_params = self.extract_recheck_parameters(strategy)
        risk_params = self.extract_risk_parameters(strategy)
        
        # Compile results
        results = {
            'strategy_name': strategy.get('name'),
            'timing_parameters': timing_params,
            'recheck_parameters': recheck_params,
            'risk_parameters': risk_params,
            'dependency_graph': self.dependency_graph.to_dict(),
            'total_parameters': (
                len(timing_params) +
                len(recheck_params) +
                len(risk_params)
            )
        }
        
        self.logger.info(
            "Strategy analysis complete",
            total_parameters=results['total_parameters'],
            timing_params=len(timing_params),
            recheck_params=len(recheck_params),
            risk_params=len(risk_params)
        )
        
        return results
    
    def extract_timing_parameters(
        self,
        strategy: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Extract timing constraint parameters for optimization.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Returns:
            List of timing parameter dictionaries with ranges
        """
        self.logger.debug("Extracting timing parameters")
        
        timing_params = []
        blocks = strategy.get('blocks', [])
        
        for block_idx, block in enumerate(blocks):
            block_name = block.get('name', f'block_{block_idx}')
            
            # Check for timing constraints
            timing_constraint = block.get('timing_constraint')
            if not timing_constraint:
                continue
            
            # Extract max_candles
            if 'max_candles' in timing_constraint:
                max_candles = int(timing_constraint['max_candles'])
                
                # Generate optimization range
                base_value = max_candles
                min_value = max(1, int(base_value * self.default_ranges['timing']['min_multiplier']))
                max_value = int(base_value * self.default_ranges['timing']['max_multiplier'])
                
                param = {
                    'block': block_name,
                    'parameter': 'max_candles',
                    'type': 'timing',
                    'base_value': base_value,
                    'current_value': base_value,
                    'min': min_value,
                    'max': max_value,
                    'step': self.default_ranges['timing']['step'],
                    'optimizable': True
                }
                
                timing_params.append(param)
                
                self.logger.debug(
                    f"Extracted timing parameter from {block_name}",
                    parameter='max_candles',
                    range=f"{min_value}-{max_value}"
                )
            
            # Extract min_candles if present
            if 'min_candles' in timing_constraint:
                min_candles = int(timing_constraint['min_candles'])
                
                param = {
                    'block': block_name,
                    'parameter': 'min_candles',
                    'type': 'timing',
                    'base_value': min_candles,
                    'current_value': min_candles,
                    'min': 0,
                    'max': timing_constraint.get('max_candles', min_candles * 2),
                    'step': self.default_ranges['timing']['step'],
                    'optimizable': True
                }
                
                timing_params.append(param)
        
        self.logger.debug(
            f"Extracted {len(timing_params)} timing parameters"
        )
        
        return timing_params
    
    def extract_recheck_parameters(
        self,
        strategy: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Extract recheck configuration parameters for optimization.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Returns:
            List of recheck parameter dictionaries with ranges
        """
        self.logger.debug("Extracting recheck parameters")
        
        recheck_params = []
        blocks = strategy.get('blocks', [])
        
        for block_idx, block in enumerate(blocks):
            block_name = block.get('name', f'block_{block_idx}')
            
            # Process signals for recheck configurations
            for signal_idx, signal in enumerate(block.get('signals', [])):
                signal_name = signal.get('name', f'signal_{signal_idx}')
                
                # Process base recheck config
                recheck_config = signal.get('recheck_config')
                if recheck_config and recheck_config.get('enabled'):
                    bar_delay = int(recheck_config.get('bar_delay', 0))
                    
                    param = {
                        'block': block_name,
                        'signal': signal_name,
                        'parameter': 'recheck_bar_delay',
                        'type': 'recheck',
                        'base_value': bar_delay,
                        'current_value': bar_delay,
                        'min': self.default_ranges['recheck']['min_bars'],
                        'max': self.default_ranges['recheck']['max_bars'],
                        'step': self.default_ranges['recheck']['step'],
                        'optimizable': True,
                        'level': 'base'
                    }
                    
                    recheck_params.append(param)
                    
                    self.logger.debug(
                        f"Extracted base recheck parameter from {block_name}::{signal_name}",
                        parameter='bar_delay',
                        value=bar_delay
                    )
                    
                    # Process nested recheck chain
                    for chain_idx, nested_recheck in enumerate(signal.get('recheck_chain', [])):
                        if nested_recheck.get('enabled'):
                            nested_delay = int(nested_recheck.get('bar_delay', 0))
                            validation_mode = nested_recheck.get('validation_mode', 'SIGNAL')
                            
                            param = {
                                'block': block_name,
                                'signal': signal_name,
                                'parameter': f'nested_recheck_{chain_idx}_delay',
                                'type': 'recheck',
                                'base_value': nested_delay,
                                'current_value': nested_delay,
                                'min': self.default_ranges['recheck']['min_bars'],
                                'max': self.default_ranges['recheck']['max_bars'],
                                'step': self.default_ranges['recheck']['step'],
                                'optimizable': True,
                                'level': 'nested',
                                'chain_index': chain_idx,
                                'validation_mode': validation_mode
                            }
                            
                            recheck_params.append(param)
                            
                            self.logger.debug(
                                f"Extracted nested recheck parameter from {block_name}::{signal_name}",
                                parameter=f'nested_recheck_{chain_idx}_delay',
                                value=nested_delay,
                                validation_mode=validation_mode
                            )
        
        self.logger.debug(
            f"Extracted {len(recheck_params)} recheck parameters"
        )
        
        return recheck_params
    
    def extract_risk_parameters(
        self,
        strategy: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Extract risk management parameters for optimization.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Returns:
            List of risk parameter dictionaries with ranges
        """
        self.logger.debug("Extracting risk parameters")
        
        risk_params = []
        risk_config = strategy.get('risk_management', {})
        
        if not risk_config:
            self.logger.warning("No risk management configuration found")
            return risk_params
        
        # Extract min_risk_reward
        if 'min_risk_reward' in risk_config:
            base_value = Decimal(str(risk_config['min_risk_reward']))
            
            param = {
                'block': 'global',
                'parameter': 'min_risk_reward',
                'type': 'risk',
                'base_value': base_value,
                'current_value': base_value,
                'min': self.default_ranges['risk']['min_risk_reward'],
                'max': self.default_ranges['risk']['max_risk_reward'],
                'step': self.default_ranges['risk']['risk_reward_step'],
                'optimizable': True
            }
            
            risk_params.append(param)
            
            self.logger.debug(
                "Extracted risk parameter",
                parameter='min_risk_reward',
                value=str(base_value)
            )
        
        # Extract risk_percent
        if 'risk_percent' in risk_config:
            base_value = Decimal(str(risk_config['risk_percent']))
            
            param = {
                'block': 'global',
                'parameter': 'risk_percent',
                'type': 'risk',
                'base_value': base_value,
                'current_value': base_value,
                'min': self.default_ranges['risk']['min_risk_percent'],
                'max': self.default_ranges['risk']['max_risk_percent'],
                'step': self.default_ranges['risk']['risk_percent_step'],
                'optimizable': True
            }
            
            risk_params.append(param)
            
            self.logger.debug(
                "Extracted risk parameter",
                parameter='risk_percent',
                value=str(base_value)
            )
        
        # Extract max_leverage
        if 'max_leverage' in risk_config:
            base_value = Decimal(str(risk_config['max_leverage']))
            
            param = {
                'block': 'global',
                'parameter': 'max_leverage',
                'type': 'risk',
                'base_value': base_value,
                'current_value': base_value,
                'min': Decimal('1.0'),
                'max': Decimal('10.0'),
                'step': Decimal('0.5'),
                'optimizable': True
            }
            
            risk_params.append(param)
        
        # Extract confluence_required
        if 'confluence_required' in risk_config:
            base_value = int(risk_config['confluence_required'])
            
            param = {
                'block': 'global',
                'parameter': 'confluence_required',
                'type': 'risk',
                'base_value': base_value,
                'current_value': base_value,
                'min': 1,
                'max': 5,
                'step': 1,
                'optimizable': True
            }
            
            risk_params.append(param)
        
        # Extract max_bars_held
        if 'max_bars_held' in risk_config:
            base_value = int(risk_config['max_bars_held'])
            
            param = {
                'block': 'global',
                'parameter': 'max_bars_held',
                'type': 'risk',
                'base_value': base_value,
                'current_value': base_value,
                'min': 5,
                'max': 50,
                'step': 1,
                'optimizable': True
            }
            
            risk_params.append(param)
        
        self.logger.debug(
            f"Extracted {len(risk_params)} risk parameters"
        )
        
        return risk_params
    
    def extract_all_parameters(
        self,
        strategy: Dict[str, Any]
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Extract all optimizable parameters from strategy.
        
        Args:
            strategy: Strategy configuration dictionary
            
        Returns:
            Dictionary with categorized parameters
        """
        return {
            'timing': self.extract_timing_parameters(strategy),
            'recheck': self.extract_recheck_parameters(strategy),
            'risk': self.extract_risk_parameters(strategy)
        }
    
    def generate_parameter_combinations(
        self,
        parameters: Dict[str, List[Dict[str,  Any]]],
        max_combinations: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        Generate parameter combinations for optimization.
        
        Args:
           parameters: Categorized parameters dictionary
            max_combinations: Maximum number of combinations to generate
            
        Returns:
            List of parameter combination dictionaries
        """
        self.logger.info(
            "Generating parameter combinations",
            max_combinations=max_combinations
        )
        
        combinations = []
        
        # Flatten all parameters
        all_params = []
        for category in parameters.values():
            all_params.extend(category)
        
        if not all_params:
            self.logger.warning("No parameters to optimize")
            return combinations
        
        # Simple grid search approach
        # For production, consider more sophisticated methods
        def generate_values(param):
            """Generate all possible values for a parameter"""
            if 'options' in param:
                return param['options']
            else:
                values = []
                current = param['min']
                step = param['step']
                
                # Handle Decimal types
                if isinstance(current, Decimal):
                    while current <= param['max']:
                        values.append(current)
                        current += step
                else:  # int
                    while current <= param['max']:
                        values.append(current)
                        current += step
                
                return values
        
        # Generate combinations (simplified - first parameter only for now)
        # Full implementation would use itertools.product for all parameters
        if all_params:
            param = all_params[0]
            values = generate_values(param)
            
            for value in values[:max_combinations]:
                combo = {
                    'parameters': {
                        f"{param['block']}.{param['parameter']}": value
                    }
                }
                combinations.append(combo)
        
        self.logger.info(
            f"Generated {len(combinations)} parameter combinations"
        )
        
        return combinations
    
    def set_default_ranges(self, ranges: Dict[str, Any]) -> None:
        """
        Update default optimization ranges.
        
        Args:
            ranges: Dictionary of default ranges to update
        """
        self.default_ranges.update(ranges)
        self.logger.debug("Updated default ranges", ranges=ranges)
    
    def get_parameter_summary(
        self,
        parameters: Dict[str, List[Dict[str, Any]]]
    ) -> Dict[str, Any]:
        """
        Get summary statistics for extracted parameters.
        
        Args:
            parameters: Categorized parameters dictionary
            
        Returns:
            Summary statistics dictionary
        """
        total = sum(len(params) for params in parameters.values())
        
        return {
            'total_parameters': total,
            'by_category': {
                cat: len(params) for cat, params in parameters.items()
            },
            'optimizable_count': sum(
                1 for params in parameters.values()
                for p in params if p.get('optimizable', False)
            )
        }
