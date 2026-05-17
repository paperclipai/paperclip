"""
AI Recommendation Enhancer
===========================

HYBRID INTELLIGENCE: Combines institutional data analysis with AI reasoning

Our Analysis (Data-Driven) → AI Enhancement (Context & Reasoning) → Optimal Recommendations

This module enables TRUE INTELLIGENCE by:
1. Passing complete strategy context to AI (OpenRouter)
2. Receiving AI-assessed optimal configurations
3. Validating AI recommendations against our analysis
4. Combining confidence scores (data + AI)
5. Providing specific, actionable settings

Key Innovation: Synergy of quantitative analysis and qualitative reasoning

Author: Optimizer v3 Team
Date: 2026-01-23
Sprint: 1.6 (Intelligent Recommendations - COMPLETE REBUILD Part 2)
"""

import os
import json
import logging
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
import requests
from datetime import datetime
from dotenv import load_dotenv
from pathlib import Path

# Import ComprehensiveAIRequestBuilder for institutional-grade prompts
from src.optimizer_v3.core.comprehensive_ai_request_builder import ComprehensiveAIRequestBuilder

import logging
logger = logging.getLogger(__name__)


# Load environment variables
load_dotenv()

# Setup logging
log_dir = Path("logs")
log_dir.mkdir(exist_ok=True)
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# Create file handler
fh = logging.FileHandler(log_dir / "ai_recommendations.log")
fh.setLevel(logging.DEBUG)

# Create formatter
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
fh.setFormatter(formatter)

# Add handler to logger
if not logger.handlers:
    logger.addHandler(fh)


@dataclass
class AIEnhancedRecommendation:
    """AI-enhanced recommendation with specific configurations"""
    type: str  # ADD_BLOCK, ADD_RECHECK, ADD_TIMING, ADJUST_PARAM
    primary: bool  # Is this the primary recommendation?
    block_name: Optional[str] = None
    signal_name: Optional[str] = None
    configuration: Dict[str, Any] = None  # Specific settings
    reasoning: str = ""
    expected_impact: Dict[str, str] = None
    confidence: float = 0.0
    ai_confidence: float = 0.0
    data_confidence: float = 0.0
    warnings: List[str] = None
    
    def __post_init__(self):
        if self.configuration is None:
            self.configuration = {}
        if self.expected_impact is None:
            self.expected_impact = {}
        if self.warnings is None:
            self.warnings = []


class AIRecommendationEnhancer:
    """
    AI-POWERED RECOMMENDATION ENHANCEMENT
    
    Uses OpenRouter API to enhance recommendations with:
    - Market context awareness
    - Nuanced configuration suggestions
    - Risk assessment
    - Optimal parameter values
    - Priority ordering
    
    Falls back gracefully if API key not available.
    """
    
    def __init__(self):
        """Initialize AI enhancer"""
        self.api_key = os.getenv('OPENROUTER_API_KEY')
        self.enabled = bool(self.api_key)
        self.model = os.getenv('AI_MODEL', 'anthropic/claude-3.5-sonnet')
        self.base_url = "https://openrouter.ai/api/v1/chat/completions"
        # Stores the full AI diagnosis from the last successful response
        # Fields: assessment, root_cause_analysis, implementation_order
        self.last_full_analysis: Dict = {}
        
        if self.enabled:
            logger.info(f"✅ AI Enhancement ENABLED (Model: {self.model})")
        else:
            logger.info("ℹ️ AI Enhancement DISABLED (No OPENROUTER_API_KEY in .env)")
    
    def enhance_recommendations(
        self,
        strategy_config: Dict,
        backtest_results: Dict,
        analysis_report,  # StrategyAnalysisReport
        preliminary_recommendations: List
    ) -> List[AIEnhancedRecommendation]:
        """
        Enhance recommendations with AI reasoning
        
        Args:
            strategy_config: Strategy configuration dict
            backtest_results: Backtest metrics
            analysis_report: Our deep analysis
            preliminary_recommendations: Our data-driven recommendations
        
        Returns:
            AI-enhanced recommendations with specific configurations
        """
        if not self.enabled:
            logger.warning("⚠️ AI enhancement skipped (not enabled)")
            return self._convert_to_enhanced_format(preliminary_recommendations)
        
        try:
            logger.info("🤖 Querying AI for recommendation enhancement...")
            
            # Build comprehensive prompt
            prompt = self._build_analysis_prompt(
                strategy_config,
                backtest_results,
                analysis_report,
                preliminary_recommendations
            )
            
            # Query AI
            ai_response = self._query_openrouter(prompt)
            
            # Parse AI response
            enhanced_recs = self._parse_ai_response(
                ai_response,
                preliminary_recommendations
            )
            
            # Validate recommendations
            validated_recs = self._validate_ai_recommendations(
                enhanced_recs,
                analysis_report
            )
            
            logger.info(f"✅ AI enhancement complete: {len(validated_recs)} recommendations")
            return validated_recs
            
        except Exception as e:
            logger.error(f"⚠️ AI enhancement failed: {str(e)}")
            logger.info("📊 Falling back to data-driven recommendations")
            return self._convert_to_enhanced_format(preliminary_recommendations)
    
    def _build_analysis_prompt(
        self,
        strategy_config: Dict,
        backtest_results: Dict,
        analysis_report,
        preliminary_recommendations: List
    ) -> str:
        """
        Build comprehensive prompt using ComprehensiveAIRequestBuilder
        
        CRITICAL FIX: Uses institutional-grade builder instead of simple format
        This ensures AI receives the SAME comprehensive data shown in preview window.
        """
        logger.info("🔧 Building institutional-grade AI prompt...")
        
        # Initialize builder
        builder = ComprehensiveAIRequestBuilder()
        
        # Prepare metrics with ratings for builder
        metrics_with_ratings = {}
        
        # Extract metrics from backtest_results
        metric_keys = [
            'total_pnl', 'win_rate', 'profit_factor', 'sharpe_ratio',
            'max_drawdown_pct', 'num_trades', 'avg_win', 'avg_loss',
            'largest_win', 'largest_loss', 'risk_reward_ratio', 'recovery_factor',
            'sortino_ratio', 'calmar_ratio', 'max_consecutive_losses'
        ]
        
        for key in metric_keys:
            if key in backtest_results:
                value = backtest_results[key]
                # Get rating from analysis if available
                rating = self._get_metric_rating(key, value, analysis_report)
                metrics_with_ratings[key] = {
                    'value': float(value) if value is not None else 0.0,
                    'rating': rating,
                    'category': 'Performance'
                }
        
        # Build complete request using builder
        request = builder.build_complete_request(
            strategy_config=strategy_config,
            backtest_results=backtest_results,
            metrics_with_ratings=metrics_with_ratings,
            backtest_config=backtest_results.get('config', {}),
            analysis_report=analysis_report
        )
        
        # Format as AI prompt (this creates the long institutional prompt)
        prompt = builder.format_for_ai_prompt(request)
        
        logger.info(f"✅ Comprehensive prompt built: {len(prompt):,} characters")
        logger.info(f"   (Expected: 50,000+ for complete data)")
        
        return prompt
    
    def _get_metric_rating(self, metric_key: str, value, analysis_report) -> str:
        """Get rating for metric based on analysis"""
        try:
            val = float(value)
            
            if metric_key == 'win_rate':
                return '✓ Good' if val >= 60 else ('⚠ Fair' if val >= 50 else '✗ Poor')
            elif metric_key == 'profit_factor':
                return '✓ Good' if val >= 2.0 else ('⚠ Fair' if val >= 1.5 else '✗ Poor')
            elif metric_key == 'sharpe_ratio':
                return '✓ Good' if val >= 2.0 else ('⚠ Fair' if val >= 1.0 else '✗ Poor')
            elif metric_key == 'max_drawdown_pct':
                return '✓ Good' if val <= 10 else ('⚠ Fair' if val <= 20 else '✗ Poor')
            elif metric_key == 'num_trades':
                return '✓ Good' if val >= 30 else ('⚠ Fair' if val >= 15 else '✗ Poor')
            else:
                return '-'
        except:
            return '-'
    
    def _query_openrouter(self, prompt: str) -> Dict:
        """
        Query OpenRouter API
        
        Args:
            prompt: Complete analysis prompt
        
        Returns:
            API response dict
        """
        try:
            # Log the request
            logger.info("="*80)
            logger.info("OPENROUTER_REQUEST_SENT")
            logger.info(f"Model: {self.model}")
            logger.info(f"Prompt Length: {len(prompt)} characters")
            logger.info(f"FULL PROMPT (ALL {len(prompt)} CHARACTERS):")
            logger.info(prompt)  # Log COMPLETE prompt to verify what's sent
            logger.info("-"*80)
            
            request_payload = {
                "model": self.model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are an elite institutional quantitative strategist specializing in "
                            "Bitcoin trading systems. You provide specific, actionable recommendations "
                            "with exact configurations. You understand signal interactions, trade frequency "
                            "impacts, and institutional risk management. Respond in valid JSON only."
                        )
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "temperature": 0.3,  # Lower for analytical reasoning
                "max_tokens": 3000,
                "response_format": {"type": "json_object"}
            }
            
            response = requests.post(
                self.base_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://github.com/btc-engine-v3",
                    "X-Title": "BTC Trade Engine - Strategy Optimizer"
                },
                json=request_payload,
                timeout=30
            )
            
            response.raise_for_status()
            response_data = response.json()
            
            # Log the response
            logger.info("="*80)
            logger.info("OPENROUTER_RESPONSE_RECEIVED")
            logger.info(f"Status Code: {response.status_code}")
            
            # Extract and log response content
            if 'choices' in response_data and len(response_data['choices']) > 0:
                content = response_data['choices'][0].get('message', {}).get('content', '')
                logger.info(f"Response Length: {len(content)} characters")
                logger.info(f"Full Response Content:\n{content}")
            else:
                logger.warning("No choices found in response")
                logger.info(f"Raw Response: {json.dumps(response_data, indent=2)}")
            
            # Log usage stats if available
            if 'usage' in response_data:
                logger.info(f"Token Usage: {response_data['usage']}")
            
            logger.info("="*80)
            
            return response_data
            
        except requests.exceptions.Timeout:
            logger.error("AI API timeout after 30 seconds")
            raise Exception("AI API timeout after 30 seconds")
        except requests.exceptions.RequestException as e:
            logger.error(f"AI API request failed: {str(e)}")
            raise Exception(f"AI API request failed: {str(e)}")
    
    def _parse_ai_response(
        self,
        ai_response: Dict,
        preliminary_recommendations: List
    ) -> List[AIEnhancedRecommendation]:
        """
        Parse AI response into enhanced recommendations.
        
        Also extracts and stores full AI diagnosis fields:
        - assessment: Overall strategy assessment text
        - root_cause_analysis: Structured root cause dict
        - implementation_order: Ordered list of implementation steps
        
        Args:
            ai_response: Raw API response
            preliminary_recommendations: Our original recommendations
        
        Returns:
            List of enhanced recommendations
        """
        try:
            # Extract content from OpenRouter response
            content = ai_response.get('choices', [{}])[0].get('message', {}).get('content', '{}')
            
            # Debug: Print first 500 chars of response
            logger.info(f"📝 AI Response (first 500 chars): {content[:500]}")
            
            # Handle markdown code block wrapping (```json ... ```)
            if content.startswith('```json'):
                # Extract JSON from markdown code block
                content = content.replace('```json', '').replace('```', '').strip()
            elif content.startswith('```'):
                content = content.replace('```', '').strip()
            
            # Parse JSON
            ai_data = json.loads(content)
            
            # ── P3: Extract full AI diagnosis fields ─────────────────────────
            assessment = ai_data.get('assessment', '')
            root_cause_analysis = ai_data.get('root_cause_analysis', {})
            implementation_order = ai_data.get('implementation_order', [])
            
            # Log any additional top-level fields at debug level so they are
            # discoverable without being silently discarded.
            known_keys = {
                'assessment', 'understanding', 'root_cause_analysis',
                'recommendations', 'implementation_order', 'risk_assessment',
                'estimated_improvement_timeline', 'overall_confidence', 'next_steps'
            }
            for key in ai_data:
                if key not in known_keys:
                    logger.debug(f"[AI Response] Extra field '{key}' (not displayed): {str(ai_data[key])[:200]}")
            
            # Store the full diagnosis for UI display
            self.last_full_analysis = {
                'assessment': assessment,
                'root_cause_analysis': root_cause_analysis,
                'implementation_order': implementation_order,
            }
            logger.debug(
                f"[AI Response] assessment={bool(assessment)}, "
                f"root_cause_analysis={bool(root_cause_analysis)}, "
                f"implementation_order={len(implementation_order)} steps"
            )
            
            # ── Extract recommendations ───────────────────────────────────────
            ai_recs = ai_data.get('recommendations', [])
            
            enhanced_recs = []
            for rec in ai_recs:
                enhanced = AIEnhancedRecommendation(
                    type=rec.get('type', 'ADD_BLOCK'),
                    primary=rec.get('primary', False),
                    block_name=rec.get('block_name'),
                    signal_name=rec.get('signal_name'),
                    configuration=rec.get('configuration', {}),
                    reasoning=rec.get('reasoning', ''),
                    expected_impact=rec.get('expected_impact', {}),
                    confidence=rec.get('confidence', 0.75),
                    ai_confidence=rec.get('confidence', 0.75),
                    data_confidence=0.75,  # From our analysis
                    warnings=rec.get('warnings', [])
                )
                enhanced_recs.append(enhanced)
            
            return enhanced_recs
            
        except json.JSONDecodeError as e:
            raise Exception(f"Failed to parse AI response as JSON: {str(e)}")
        except Exception as e:
            raise Exception(f"Failed to parse AI recommendations: {str(e)}")
    
    def _validate_ai_recommendations(
        self,
        ai_recommendations: List[AIEnhancedRecommendation],
        analysis_report
    ) -> List[AIEnhancedRecommendation]:
        """
        Validate AI recommendations against our analysis
        
        Safety check: Ensure AI recommendations make sense given our data
        
        Args:
            ai_recommendations: AI-generated recommendations
            analysis_report: Our analysis report
        
        Returns:
            Validated recommendations
        """
        validated = []
        
        for rec in ai_recommendations:
            # Validation checks
            valid = True
            warnings = list(rec.warnings)
            
            # Check 1: If recommending new block, ensure not already in strategy
            if rec.type == 'ADD_BLOCK' and rec.block_name:
                if rec.block_name in analysis_report.block_names:
                    valid = False
                    warnings.append(f"Block '{rec.block_name}' already in strategy")
            
            # Check 2: If adding recheck, ensure block exists
            if rec.type == 'ADD_RECHECK' and rec.block_name:
                if rec.block_name not in analysis_report.block_names:
                    valid = False
                    warnings.append(f"Block '{rec.block_name}' not in strategy")
            
            # Check 3: Trade frequency warning
            if rec.type == 'ADD_BLOCK':
                if analysis_report.trade_frequency.frequency_assessment in ['TOO_LOW', 'LOW']:
                    warnings.append(
                        "WARNING: Trade frequency already low - adding block will reduce further"
                    )
            
            # Check 4: Confidence sanity check
            if rec.confidence > 0.95:
                rec.confidence = 0.95  # Cap at 95% (never 100% certain)
            
            # Update warnings
            rec.warnings = warnings
            
            if valid:
                validated.append(rec)
        
        return validated
    
    def _convert_to_enhanced_format(
        self,
        preliminary_recommendations: List
    ) -> List[AIEnhancedRecommendation]:
        """
        Convert preliminary recommendations to enhanced format
        (Used when AI not available)
        """
        enhanced = []
        
        for rec in preliminary_recommendations:
            rec_dict = rec if isinstance(rec, dict) else asdict(rec)
            
            enhanced_rec = AIEnhancedRecommendation(
                type=rec_dict.get('action_type', 'ADD_BLOCK'),
                primary=True,
                block_name=rec_dict.get('block_name'),
                signal_name=None,
                configuration={},
                reasoning=rec_dict.get('description', ''),
                expected_impact={
                    rec_dict.get('metric', 'win_rate'): f"{rec_dict.get('expected_improvement', 0):.1%}"
                },
                confidence=rec_dict.get('confidence', 0.75),
                ai_confidence=0.0,
                data_confidence=rec_dict.get('confidence', 0.75),
                warnings=[]
            )
            enhanced.append(enhanced_rec)
        
        return enhanced
    
    def format_recommendation_text(self, rec: AIEnhancedRecommendation) -> str:
        """Format enhanced recommendation as display text"""
        
        # Build header
        if rec.ai_confidence > 0:
            header = "🤖 AI-ENHANCED:"
        else:
            header = "📊 DATA-DRIVEN:"
        
        # Build main text
        if rec.type == 'ADD_BLOCK':
            text = f"{header} Add '{rec.block_name}' block"
        elif rec.type == 'ADD_RECHECK':
            bar_delay = rec.configuration.get('bar_delay', 25)
            text = f"{header} Add recheck to '{rec.block_name}::{rec.signal_name}' (delay: {bar_delay} bars)"
        elif rec.type == 'ADD_TIMING':
            max_candles = rec.configuration.get('max_candles', 20)
            text = f"{header} Add timing dependency (within {max_candles} candles)"
        elif rec.type == 'ADJUST_PARAM':
            text = f"{header} Adjust {rec.configuration.get('parameter_name', 'parameter')}"
        else:
            text = f"{header} {rec.reasoning[:100]}"
        
        # Add impact
        if rec.expected_impact:
            impacts = [f"{k}: {v}" for k, v in rec.expected_impact.items()]
            text += f" (Expected: {', '.join(impacts[:2])})"
        
        # Add confidence
        text += f" [Confidence: {rec.confidence:.0%}]"
        
        return text


# Test function
def test_ai_enhancer():
    """Test AI enhancer with sample data"""
    import sys
    from pathlib import Path
    
    # Add project root to path
    project_root = Path(__file__).parent.parent.parent.parent
    sys.path.insert(0, str(project_root))
    
    logger.info("\n" + "=" * 80)
    logger.info("AI RECOMMENDATION ENHANCER - LIVE TEST")
    logger.info("=" * 80)
    
    enhancer = AIRecommendationEnhancer()
    
    if not enhancer.enabled:
        logger.error("\n❌ AI Enhancement not available (no API key)")
        logger.info("Set OPENROUTER_API_KEY in .env to enable")
        return
    
    # Sample test data
    strategy_config = {
        'name': 'HOD Rejection Test',
        'strategy_type': 'Bearish',
        'blocks': [
            {'name': 'hod', 'signals': [{'name': 'HOD_REJECTION'}]},
            {'name': 'stochastic_rsi', 'signals': [{'name': 'BEARISH_CROSS'}]},
            {'name': 'rsi_divergence', 'signals': [{'name': 'BEARISH_DIVERGENCE'}]}
        ]
    }
    
    backtest_results = {
        'total_pnl': 544.0,
        'win_rate': 58.3,
        'profit_factor': 1.97,
        'max_drawdown_pct': 5.58,
        'num_trades': 24,
        'avg_win': 78.75,
        'avg_loss': -55.85
    }
    
    # Create mock analysis report
    from src.optimizer_v3.core.strategy_deep_analyzer import (
        TradeFrequencyAnalysis, StrategyGaps, StrategyAnalysisReport,
        SignalInteraction, RootCauseAnalysis, RootCause
    )
    from src.optimizer_v3.core.block_intelligence_extractor import BlockPurpose
    
    analysis_report = StrategyAnalysisReport(
        strategy_name='HOD Rejection Test',
        num_blocks=3,
        num_signals=3,
        block_names=['hod', 'stochastic_rsi', 'rsi_divergence'],
        trade_frequency=TradeFrequencyAnalysis(
            current_trades_per_year=48,
            current_trades_per_month=4.0,
            signal_frequency_product=0.0075,
            individual_signal_rates={'hod': 0.05, 'stochastic_rsi': 0.15, 'rsi_divergence': 0.10},
            frequency_assessment='LOW',
            frequency_risk='MODERATE',
            minimum_needed_for_validation=30
        ),
        gaps=StrategyGaps(
            missing_purposes=[BlockPurpose.RISK_MANAGEMENT, BlockPurpose.VOLATILITY_FILTER],
            coverage_score=0.25,
            critical_gaps=['Missing RISK_MANAGEMENT'],
            nice_to_have_gaps=['Missing VOLATILITY_FILTER'],
            redundant_blocks=[]
        ),
        signal_interactions=SignalInteraction(
            logic_type='AND',
            interaction_factor=0.0075,
            complementary=True,
            conflicting=False,
            sequence_matters=True,
            timing_dependencies=[]
        ),
        root_causes={
            'win_rate': RootCauseAnalysis(
                root_causes=[RootCause.TOO_FEW_TRADES],
                primary_cause=RootCause.TOO_FEW_TRADES,
                confidence=0.85,
                reasoning="Win rate 58.3% based on only 24 trades",
                supporting_evidence=["Only 4 trades/month", "Need 30 trades minimum"]
            )
        },
        strategy_quality_score=6.5,
        key_issues=["Trade frequency too low (4/month)", "Missing risk management"],
        strengths=["Good win rate (58.3%)", "Low drawdown (5.58%)"]
    )
    
    preliminary_recommendations = [
        {
            'action_type': 'ADD_BLOCK',
            'block_name': 'atr',
            'description': 'ATR for volatility filtering',
            'expected_improvement': 0.15,
            'confidence': 0.75,
            'metric': 'win_rate'
        }
    ]
    
    logger.info("\n🔬 Testing AI enhancement...")
    try:
        enhanced = enhancer.enhance_recommendations(
            strategy_config,
            backtest_results,
            analysis_report,
            preliminary_recommendations
        )
        
        logger.info(f"\n✅ Received {len(enhanced)} enhanced recommendations:")
        for i, rec in enumerate(enhanced, 1):
            logger.info(f"\n{i}. {enhancer.format_recommendation_text(rec)}")
            logger.info(f"   Reasoning: {rec.reasoning[:200]}...")
            if rec.warnings:
                logger.warning(f"   ⚠️ Warnings: {', '.join(rec.warnings)}")
        
    except Exception as e:
        logger.error(f"\n❌ Test failed: {str(e)}")
    
    logger.info("\n" + "=" * 80)


if __name__ == '__main__':
    test_ai_enhancer()
