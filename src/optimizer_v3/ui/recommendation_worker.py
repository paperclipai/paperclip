"""
Recommendation Worker - Background Thread for AI Generation

Runs AI recommendation generation in background to prevent UI freeze.
Provides progress callback for modal dialog.

Author: Optimizer v3 Team
Date: 2026-01-23
Sprint: 1.6 (Critical UX Fix)
"""

from typing import Dict, List, Optional, Callable
from PyQt5.QtCore import QThread, pyqtSignal

from src.optimizer_v3.core.intelligent_recommendation_engine import (
    IntelligentRecommendationEngine,
    IntegratedRecommendation
)


class RecommendationWorker(QThread):
    """
    Background worker for AI recommendation generation.
    
    Prevents UI freeze during 30-40 second AI operations.
    Provides progress feedback via signals.
    """
    
    # Signals
    recommendations_ready = pyqtSignal(list)  # List[IntegratedRecommendation]
    progress_update = pyqtSignal(str, int)  # (message, percentage)
    error_occurred = pyqtSignal(str)  # error message
    
    def __init__(
        self,
        engine: IntelligentRecommendationEngine,
        strategy_config: Dict,
        backtest_results: Dict,
        metrics: Dict,
        lookback_days: int = 180
    ):
        super().__init__()
        self.engine = engine
        self.strategy_config = strategy_config
        self.backtest_results = backtest_results
        self.metrics = metrics
        self.lookback_days = lookback_days
    
    def run(self):
        """Run AI generation in background thread"""
        try:
            # Override status callback to emit progress
            def progress_callback(message: str):
                # Parse message for progress estimation
                if "STEP 1/5" in message:
                    self.progress_update.emit(message, 20)
                elif "STEP 2/5" in message:
                    self.progress_update.emit(message, 40)
                elif "STEP 3/5" in message:
                    self.progress_update.emit(message, 60)
                elif "STEP 4/5" in message:
                    self.progress_update.emit(message, 80)
                elif "STEP 5/5" in message:
                    self.progress_update.emit(message, 95)
                else:
                    self.progress_update.emit(message, -1)  # Unknown progress
            
            # Temporarily override engine's callback
            original_callback = self.engine.status_callback
            self.engine.status_callback = progress_callback
            
            # Generate recommendations (blocking call - but in background thread)
            recommendations = self.engine.generate_recommendations(
                strategy_config=self.strategy_config,
                backtest_results=self.backtest_results,
                metrics=self.metrics,
                lookback_days=self.lookback_days
            )
            
            # Restore original callback
            self.engine.status_callback = original_callback
            
            # Emit completion
            self.progress_update.emit("✅ Recommendations generated successfully", 100)
            self.recommendations_ready.emit(recommendations)
            
        except Exception as e:
            error_msg = f"AI recommendation generation failed: {str(e)}"
            self.error_occurred.emit(error_msg)
            import traceback
            traceback.print_exc()
