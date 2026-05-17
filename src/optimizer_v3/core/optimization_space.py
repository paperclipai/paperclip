"""
Optimizer V3 - Optimization Space Generator
Generates and validates complete optimization parameter spaces.
"""

from typing import Dict, List, Any, Optional, Tuple, Iterator
from decimal import Decimal
from itertools import product
from copy import deepcopy

from src.optimizer_v3.core.logger import OptimizerLogger
from src.optimizer_v3.core.validator import DataValidator, ValidationError

import logging
logger = logging.getLogger(__name__)



class OptimizationSpace:
    """
    Generate and manage optimization parameter spaces.
    
    Features:
    - Generate parameter combinations
    - Validate parameter ranges
    - Limit combination explosion
    - Support for different parameter types
    - Intelligent sampling strategies
    
    Args:
        logger: OptimizerLogger instance for logging
        validator: DataValidator instance for validation
        max_combinations: Maximum number of combinations (default: 10000)
    """
    
    def __init__(
        self,
        logger: Optional[OptimizerLogger] = None,
        validator: Optional[DataValidator] = None,
        max_combinations: int = 10000
    ):
        self.logger = logger or OptimizerLogger('optimization_space')
        self.validator = validator or DataValidator(self.logger)
        self.max_combinations = max_combinations
        
        # Generated spaces
        self.parameter_space: List[Dict[str, Any]] = []
        self.metadata: Dict[str, Any] = {}
    
    def generate_optimization_space(
        self,
        parameters: Dict[str, List[Dict[str, Any]]],
        sampling_strategy: str = 'grid'
    ) -> List[Dict[str, Any]]:
        """
        Generate complete optimization space from parameters.
        
        Args:
            parameters: Categorized parameters dictionary
            sampling_strategy: Strategy for sampling ('grid', 'random', 'adaptive')
            
        Returns:
            List of parameter configuration dictionaries
        """
        self.logger.info(
            "Generating optimization space",
            strategy=sampling_strategy,
            max_combinations=self.max_combinations
        )
        
        # Flatten all parameters
        all_params = []
        for category,  params in parameters.items():
            all_params.extend(params)
        
        if not all_params:
            self.logger.warning("No parameters to optimize")
            return []
        
        # Generate based on strategy
        if sampling_strategy == 'grid':
            configs = self._generate_grid_space(all_params)
        elif sampling_strategy == 'random':
            configs = self._generate_random_space(all_params)
        elif sampling_strategy == 'adaptive':
            configs = self._generate_adaptive_space(all_params)
        else:
            raise ValueError(f"Unknown sampling strategy: {sampling_strategy}")
        
        # Store metadata
        self.metadata = {
            'strategy': sampling_strategy,
            'num_parameters': len(all_params),
            'num_configurations': len(configs),
            'parameters': [
                {
                    'name': f"{p['block']}.{p['parameter']}",
                    'type': p['type'],
                    'range': f"{p.get('min', 'N/A')}-{p.get('max', 'N/A')}"
                }
                for p in all_params
            ]
        }
        
        self.parameter_space = configs
        
        self.logger.info(
            "Optimization space generated",
            num_configs=len(configs),
            num_params=len(all_params)
        )
        
        return configs
    
    def _generate_grid_space(
        self,
        parameters: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Generate grid search space (all combinations).
        
        Args:
            parameters: List of parameter dictionaries
            
        Returns:
            List of configuration dictionaries
        """
        self.logger.debug("Generating grid search space")
        
        # Generate value lists for each parameter
        param_values = []
        param_names = []
        
        for param in parameters:
            values = self._generate_parameter_values(param)
            param_values.append(values)
            param_names.append(f"{param['block']}.{param['parameter']}")
        
        # Calculate total combinations
        total_combinations = 1
        for values in param_values:
            total_combinations *= len(values)
        
        self.logger.debug(
            f"Total possible combinations: {total_combinations}"
        )
        
        # Limit if too large
        if total_combinations > self.max_combinations:
            self.logger.warning(
                f"Total combinations ({total_combinations}) exceeds "
                f"maximum ({self.max_combinations}). Sampling..."
            )
            return self._sample_grid_space(
                param_names,
                param_values,
                self.max_combinations
            )
        
        # Generate all combinations
        configs = []
        for combination in product(*param_values):
            config = {
                'parameters': dict(zip(param_names, combination))
            }
            configs.append(config)
        
        return configs
    
    def _generate_random_space(
        self,
        parameters: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Generate random sampling space.
        
        Args:
            parameters: List of parameter dictionaries
            
        Returns:
            List of configuration dictionaries
        """
        import random
        
        self.logger.debug("Generating random sampling space")
        
        configs = []
        num_samples = min(self.max_combinations, 1000)
        
        for _ in range(num_samples):
            config = {'parameters': {}}
            
            for param in parameters:
                param_name = f"{param['block']}.{param['parameter']}"
                value = self._sample_random_value(param)
                config['parameters'][param_name] = value
            
            configs.append(config)
        
        return configs
    
    def _generate_adaptive_space(
        self,
        parameters: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Generate adaptive sampling space (focuses on promising regions).
        
        Args:
            parameters: List of parameter dictionaries
            
        Returns:
            List of configuration dictionaries
        """
        self.logger.debug("Generating adaptive sampling space")
        
        # Start with grid around base values
        configs = []
        
        for param in parameters:
            param_name = f"{param['block']}.{param['parameter']}"
            base_value = param['base_value']
            
            # Generate values around base
            if 'options' in param:
                values = param['options']
            else:
                # Create 5 points around base value
                values = self._generate_adaptive_values(param)
            
            for value in values:
                config = {
                    'parameters': {param_name: value}
                }
                configs.append(config)
        
        return configs[:self.max_combinations]
    
    def _generate_parameter_values(
        self,
        param: Dict[str, Any]
    ) -> List[Any]:
        """
        Generate all possible values for a parameter.
        
        Args:
            param: Parameter dictionary
            
        Returns:
            List of all possible values
        """
        if 'options' in param:
            return param['options'].copy()
        
        values = []
        current = param['min']
        step = param['step']
        max_val = param['max']
        
        # Handle Decimal types
        if isinstance(current, Decimal):
            while current <= max_val:
                values.append(current)
                current += step
        else:  # int
            while current <= max_val:
                values.append(current)
                current += step
        
        return values
    
    def _sample_grid_space(
        self,
        param_names: List[str],
        param_values: List[List[Any]],
        num_samples: int
    ) -> List[Dict[str, Any]]:
        """
        Sample from grid space when full space is too large.
        
        Args:
            param_names: List of parameter names
            param_values: List of value lists for each parameter
            num_samples: Number of samples to generate
            
        Returns:
            List of sampled configuration dictionaries
        """
        import random
        
        configs = []
        
        for _ in range(num_samples):
            # Sample one value from each parameter
            combination = [
                random.choice(values) for values in param_values
            ]
            
            config = {
                'parameters': dict(zip(param_names, combination))
            }
            configs.append(config)
        
        return configs
    
    def _sample_random_value(self, param: Dict[str, Any]) -> Any:
        """
        Sample a random value for a parameter.
        
        Args:
            param: Parameter dictionary
            
        Returns:
            Random value within parameter range
        """
        import random
        
        if 'options' in param:
            return random.choice(param['options'])
        
        min_val = param['min']
        max_val = param['max']
        step = param['step']
        
        if isinstance(min_val, Decimal):
            # For Decimal, convert to float for random sampling
            min_f = float(min_val)
            max_f = float(max_val)
            step_f = float(step)
            
            # Generate random number of steps
            num_steps = int((max_f - min_f) / step_f)
            random_step = random.randint(0, num_steps)
            
            return Decimal(str(min_f + random_step * step_f))
        else:
            # For int
            return random.randrange(min_val, max_val + 1, step)
    
    def _generate_adaptive_values(
        self,
        param: Dict[str, Any]
    ) -> List[Any]:
        """
        Generate adaptive values around base value.
        
        Args:
            param: Parameter dictionary
            
        Returns:
            List of values around base
        """
        base = param['base_value']
        min_val = param['min']
        max_val = param['max']
        step = param['step']
        
        # Generate 5 points: min, 25%, 50% (base), 75%, max
        values = []
        
        if isinstance(base, Decimal):
            range_val = max_val - min_val
            values = [
                min_val,
                min_val + range_val * Decimal('0.25'),
                base,
                min_val + range_val * Decimal('0.75'),
                max_val
            ]
        else:
            range_val = max_val - min_val
            values = [
                min_val,
                min_val + int(range_val * 0.25),
                base,
                min_val + int(range_val * 0.75),
                max_val
            ]
        
        # Remove duplicates and sort
        unique_values = sorted(set(values))
        return unique_values
    
    def validate_optimization_space(
        self,
        configs: Optional[List[Dict[str, Any]]] = None
    ) -> Tuple[bool, List[str]]:
        """
        Validate optimization space configurations.
        
        Args:
            configs: List of configurations to validate (uses generated if None)
            
        Returns:
            Tuple of (is_valid, list_of_errors)
        """
        if configs is None:
            configs = self.parameter_space
        
        self.logger.info(f"Validating {len(configs)} configurations")
        
        errors = []
        
        # Check for empty space
        if not configs:
            errors.append("Optimization space is empty")
            return False, errors
        
        # Validate each configuration
        for idx, config in enumerate(configs):
            # Check structure
            if 'parameters' not in config:
                errors.append(f"Config {idx}: Missing 'parameters' key")
                continue
            
            if not isinstance(config['parameters'], dict):
                errors.append(f"Config {idx}: 'parameters' must be dict")
                continue
            
            # Validate parameter values
            for param_name, value in config['parameters'].items():
                if value is None:
                    errors.append(
                        f"Config {idx}: Parameter '{param_name}' is None"
                    )
        
        # Check for duplicates
        seen_configs = set()
        for idx, config in enumerate(configs):
            config_key = frozenset(config['parameters'].items())
            if config_key in seen_configs:
                errors.append(f"Config {idx}: Duplicate configuration")
            seen_configs.add(config_key)
        
        is_valid = len(errors) == 0
        
        if is_valid:
            self.logger.info("Optimization space validation passed")
        else:
            self.logger.error(
                f"Optimization space validation failed with {len(errors)} errors"
            )
        
        return is_valid, errors
    
    def get_space_statistics(self) -> Dict[str, Any]:
        """
        Get statistics about the optimization space.
        
        Returns:
            Dictionary with space statistics
        """
        if not self.parameter_space:
            return {'error': 'No optimization space generated'}
        
        # Count unique values per parameter
        param_value_counts = {}
        for config in self.parameter_space:
            for param_name, value in config['parameters'].items():
                if param_name not in param_value_counts:
                    param_value_counts[param_name] = set()
                param_value_counts[param_name].add(str(value))
        
        return {
            'total_configurations': len(self.parameter_space),
            'num_parameters': len(param_value_counts),
            'values_per_parameter': {
                name: len(values)
                for name, values in param_value_counts.items()
            },
            'metadata': self.metadata
        }
    
    def get_configurations(self) -> List[Dict[str, Any]]:
        """
        Get generated configurations.
        
        Returns:
            List of configuration dictionaries
        """
        return self.parameter_space.copy()
    
    def clear(self) -> None:
        """Clear generated optimization space."""
        self.parameter_space.clear()
        self.metadata.clear()
        self.logger.debug("Optimization space cleared")
