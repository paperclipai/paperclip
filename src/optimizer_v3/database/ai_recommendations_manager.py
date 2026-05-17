"""
AI Recommendations Manager
SPRINT 1.6.1 - Phase 1 Day 2

Manages AI-generated recommendations for strategy improvements.
Tracks recommendations, application status, and effectiveness.

Institutional-grade implementation with:
- Recommendation tracking and history
- Application status monitoring
- Effectiveness measurement
- Feedback loop for AI improvement
"""

from typing import Optional, List, Dict, Any
from uuid import uuid4
from datetime import datetime, timezone
import json
import logging
from sqlalchemy.orm import Session
from sqlalchemy import text

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


class AIRecommendationsManager:
    """
    Database manager for AI recommendation tracking and analysis
    
    Provides:
    - Create recommendations with detailed rationale
    - Track application status
    - Measure effectiveness post-application
    - Query by strategy, type, status
    - Feedback loop for AI model improvement
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize AI recommendations manager
        
        Args:
            db_session: SQLAlchemy session for database operations
        """
        self.session = db_session
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
    
    def create_recommendation(self, recommendation_data: Dict[str, Any]) -> str:
        """
        Create new AI recommendation using ORM
        
        Args:
            recommendation_data: Recommendation details including:
                - strategy_id (str): Target strategy
                - strategy_version_id (str, optional): Specific version
                - recommendation_type (str): Type (performance, risk, signal, parameter)
                - title (str): Brief title
                - description (str): Detailed description
                - rationale (str): AI reasoning
                - suggested_changes (dict): Proposed modifications
                - expected_impact (dict): Projected improvements
                - confidence_score (float): AI confidence (0.0-1.0)
                - priority (str, optional): high, medium, low
                - model_version (str, optional): AI model version
                - analysis_data (dict, optional): Supporting analysis
                
        Returns:
            recommendation_id: UUID string of created recommendation
            
        Raises:
            ValueError: If required fields missing or invalid
            
        Real Money Impact: HIGH - Creates AI recommendations for trading strategies
        
        """
        # Validate required fields
        required = ['strategy_id', 'recommendation_type', 'reasoning']
        missing = [f for f in required if f not in recommendation_data]
        if missing:
            raise ValueError(f"Missing required fields: {', '.join(missing)}")
        
        # Validate recommendation type
        valid_types = ['performance', 'risk', 'signal', 'parameter', 'entry', 'exit', 'general']
        if recommendation_data['recommendation_type'] not in valid_types:
            raise ValueError(f"Invalid type. Must be one of: {', '.join(valid_types)}")
        
        # Use raw SQL insert for columns that exist in the current DB schema.
        # The AIRecommendation ORM model defines columns (title, description,
        # rationale, suggested_changes, priority, applied_version_id,
        # applied_by) that have not been migrated to the PostgreSQL table yet.
        # Raw SQL avoids the ORM including unmigrated columns in the INSERT.
        import uuid as _uuid_mod
        _rec_id = _uuid_mod.uuid4()
        _now = datetime.now(timezone.utc)
        _reasoning = recommendation_data.get('reasoning', recommendation_data.get('rationale', ''))
        _confidence = recommendation_data.get('combined_confidence', recommendation_data.get('confidence_score', 0.5))
        _expected_impact = recommendation_data.get('expected_impact', {})
        _configuration = recommendation_data.get('configuration')
        _version_id = recommendation_data.get('strategy_version_id')
        
        _strategy_version = recommendation_data.get('strategy_version')
        if _strategy_version is None and _version_id is not None:
            _vr = self.session.execute(
                text("SELECT version_number FROM strategy_versions WHERE version_id = :vid"),
                {"vid": _version_id}
            ).scalar()
            if _vr is not None:
                _strategy_version = str(_vr)

        try:
            self.session.execute(
                text("""
                    INSERT INTO ai_recommendations
                        (recommendation_id, strategy_id, version_id,
                         strategy_version, timestamp, recommendation_type,
                         reasoning, expected_impact, combined_confidence,
                         configuration, created_at)
                    VALUES
                        (:rec_id, :strategy_id, :version_id,
                         :strategy_version, :ts, :rec_type,
                         :reasoning, :expected_impact, :combined_confidence,
                         :configuration, :created_at)
                """),
                {
                    "rec_id": _rec_id,
                    "strategy_id": recommendation_data['strategy_id'],
                    "version_id": _version_id,
                    "strategy_version": _strategy_version,
                    "ts": _now,
                    "rec_type": recommendation_data['recommendation_type'],
                    "reasoning": _reasoning,
                    "expected_impact": json.dumps(_expected_impact) if isinstance(_expected_impact, dict) else _expected_impact,
                    "combined_confidence": _confidence,
                    "configuration": json.dumps(_configuration) if isinstance(_configuration, dict) else _configuration,
                    "created_at": _now,
                }
            )
            self.session.commit()
            
            rec_id = str(_rec_id)
            self.logger.info(
                f"Created AI recommendation: {rec_id} "
                f"(strategy: {recommendation_data['strategy_id']}, type: {recommendation_data['recommendation_type']})"
            )
            return rec_id
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to create recommendation: {e}")
            raise
    
    def get_recommendation(self, recommendation_id: str) -> Optional[Dict[str, Any]]:
        """
        Get recommendation by ID

        Uses raw SQL to avoid ORM columns that have not been migrated
        to the current PostgreSQL schema yet.
        """
        try:
            row = self.session.execute(
                text("""
                    SELECT recommendation_id, strategy_id, version_id,
                           recommendation_type, reasoning,
                           expected_impact, configuration,
                           combined_confidence, applied, applied_at,
                           created_at
                    FROM ai_recommendations
                    WHERE recommendation_id = :rid
                """),
                {"rid": recommendation_id}
            ).mappings().first()

            if not row:
                return None

            return {
                'recommendation_id': str(row['recommendation_id']),
                'strategy_id': row['strategy_id'],
                'strategy_version_id': str(row['version_id']) if row['version_id'] else None,
                'recommendation_type': row['recommendation_type'],
                'reasoning': row['reasoning'],
                'configuration': row['configuration'],
                'expected_impact': row['expected_impact'],
                'combined_confidence': row['combined_confidence'],
                'applied': row['applied'],
                'applied_at': row['applied_at'],
                'created_at': row['created_at'],
            }

        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get recommendation {recommendation_id}: {e}")
            return None
            
            # Convert ORM object to dict
            # JSONB fields are automatically deserialized by SQLAlchemy
            rec_dict = {
                'recommendation_id': str(recommendation.recommendation_id),
                'strategy_id': recommendation.strategy_id,
                'strategy_version_id': str(recommendation.strategy_version_id) if recommendation.strategy_version_id else None,
                'recommendation_type': recommendation.recommendation_type,
                'reasoning': recommendation.reasoning,
                # JSONB fields - already Python objects
                'configuration': recommendation.configuration,
                'expected_impact': recommendation.expected_impact,
                'warnings': recommendation.warnings,
                # Other fields
                'combined_confidence': recommendation.combined_confidence,
                'block_name': recommendation.block_name,
                'signal_name': recommendation.signal_name,
                'parameter_name': recommendation.parameter_name,
                'root_cause': recommendation.root_cause,
                'ai_enhanced': recommendation.ai_enhanced,
                'applied': recommendation.applied,
                'applied_at': recommendation.applied_at,
                'metrics_before': recommendation.metrics_before,
                'metrics_after': recommendation.metrics_after,
                'created_at': recommendation.created_at
            }
            
            return rec_dict
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get recommendation {recommendation_id}: {e}")
            return None
    
    def get_strategy_recommendations(
        self,
        strategy_id: str,
        applied_only: bool = False,
        pending_only: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Get all recommendations for a strategy

        Uses raw SQL to avoid ORM columns that have not been migrated.
        """
        try:
            where = "WHERE strategy_id = :sid"
            params: dict = {"sid": strategy_id}
            if applied_only:
                where += " AND applied = TRUE"
            elif pending_only:
                where += " AND (applied IS NULL OR applied = FALSE)"

            rows = self.session.execute(
                text(
                    f"SELECT recommendation_id, strategy_id, version_id, "
                    f"recommendation_type, reasoning, expected_impact, "
                    f"configuration, combined_confidence, applied, applied_at, "
                    f"created_at "
                    f"FROM ai_recommendations {where} "
                    f"ORDER BY created_at DESC"
                ),
                params
            ).mappings().all()

            result_list = []
            for row in rows:
                result_list.append({
                    'recommendation_id': str(row['recommendation_id']),
                    'strategy_id': row['strategy_id'],
                    'strategy_version_id': str(row['version_id']) if row['version_id'] else None,
                    'recommendation_type': row['recommendation_type'],
                    'reasoning': row['reasoning'],
                    'configuration': row['configuration'],
                    'expected_impact': row['expected_impact'],
                    'combined_confidence': row['combined_confidence'],
                    'applied': row['applied'],
                    'applied_at': row['applied_at'],
                    'created_at': row['created_at'],
                })

            return result_list

        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get recommendations for strategy {strategy_id}: {e}")
            return []
    
    def mark_applied(
        self,
        recommendation_id: str,
        applied_version_id: str,
        applied_by: Optional[str] = None
    ) -> bool:
        """
        Mark recommendation as applied to a version

        Uses raw SQL to avoid ORM columns that have not been migrated.
        """
        try:
            result = self.session.execute(
                text("""
                    UPDATE ai_recommendations
                    SET applied = TRUE,
                        applied_at = :now
                    WHERE recommendation_id = :rid
                """),
                {"rid": recommendation_id, "now": datetime.now(timezone.utc)}
            )
            self.session.commit()

            updated = result.rowcount > 0
            if updated:
                self.logger.info(f"Marked recommendation {recommendation_id} as applied")
            return updated

        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to mark recommendation {recommendation_id} as applied: {e}")
            return False

            # Update using ORM
            recommendation.applied = True
            recommendation.applied_at = datetime.now(timezone.utc)

            # Store applied metadata in configuration JSONB (columns not in current schema)
            if recommendation.configuration is None:
                recommendation.configuration = {}
            recommendation.configuration['applied_version_id'] = applied_version_id
            if applied_by:
                recommendation.configuration['applied_by'] = applied_by

            self.session.commit()

            self.logger.info(f"Marked recommendation {recommendation_id} as applied to {applied_version_id}")
            return True

        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to mark recommendation {recommendation_id} as applied: {e}")
            return False
    
    def record_impact(
        self,
        recommendation_id: str,
        actual_impact: Dict[str, Any]
    ) -> bool:
        """
        Record actual impact after recommendation application using ORM
        
        Args:
            recommendation_id: Recommendation UUID
            actual_impact: Actual measured impact data (Python dict)
            
        Returns:
            True if updated, False if not found
            
        ORM Refactored: Sprint 1.6.1 Task 2.1.6
        """
        from src.optimizer_v3.database.models import AIRecommendation
        
        try:
            recommendation = self.session.query(AIRecommendation).filter_by(
                recommendation_id=recommendation_id
            ).first()
            
            if not recommendation:
                return False
            
            # Update JSONB field - SQLAlchemy handles serialization
            recommendation.metrics_after = actual_impact
            
            self.session.commit()
            
            self.logger.info(f"Recorded impact for recommendation {recommendation_id}")
            return True
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to record impact for {recommendation_id}: {e}")
            return False
    
    def get_recommendations_by_type(
        self,
        recommendation_type: str
    ) -> List[Dict[str, Any]]:
        """
        Get all recommendations of specific type using ORM
        
        Args:
            recommendation_type: Type to filter by
            
        Returns:
            List of recommendation dicts with JSONB auto-deserialized
            
        ORM Refactored: Sprint 1.6.1 Task 2.1.3
        """
        from src.optimizer_v3.database.models import AIRecommendation
        
        try:
            recommendations = self.session.query(AIRecommendation).filter_by(
                recommendation_type=recommendation_type
            ).order_by(AIRecommendation.created_at.desc()).all()
            
            return [self._recommendation_to_dict(rec) for rec in recommendations]
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get recommendations by type {recommendation_type}: {e}")
            return []
    
    def _recommendation_to_dict(self, rec) -> Dict[str, Any]:
        """Helper to convert ORM object to dict"""
        return {
            'recommendation_id': str(rec.recommendation_id),
            'strategy_id': rec.strategy_id,
            'strategy_version_id': str(rec.strategy_version_id) if rec.strategy_version_id else None,
            'recommendation_type': rec.recommendation_type,
            'reasoning': rec.reasoning,
            'configuration': rec.configuration,
            'expected_impact': rec.expected_impact,
            'warnings': rec.warnings,
            'combined_confidence': rec.combined_confidence,
            'block_name': rec.block_name,
            'signal_name': rec.signal_name,
            'parameter_name': rec.parameter_name,
            'root_cause': rec.root_cause,
            'ai_enhanced': rec.ai_enhanced,
            'applied': rec.applied,
            'applied_at': rec.applied_at,
            'metrics_before': rec.metrics_before,
            'metrics_after': rec.metrics_after,
            'created_at': rec.created_at
        }
    
    def get_high_confidence_pending(
        self,
        min_confidence: float = 0.7
    ) -> List[Dict[str, Any]]:
        """
        Get pending recommendations with high confidence scores using ORM
        
        Args:
            min_confidence: Minimum confidence threshold (0.0-1.0)
            
        Returns:
            List of high-confidence pending recommendations
            
        ORM Refactored: Sprint 1.6.1 Task 2.1.4
        """
        from src.optimizer_v3.database.models import AIRecommendation
        
        try:
            recommendations = self.session.query(AIRecommendation).filter(
                AIRecommendation.applied == False,
                AIRecommendation.combined_confidence >= min_confidence
            ).order_by(
                AIRecommendation.combined_confidence.desc(),
                AIRecommendation.created_at.desc()
            ).all()
            
            return [self._recommendation_to_dict(rec) for rec in recommendations]
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get high confidence recommendations: {e}")
            return []
    
    def get_effectiveness_stats(self) -> Dict[str, Any]:
        """
        Get statistics on recommendation effectiveness using ORM
        
        Returns:
            Dict with effectiveness metrics including:
            - total_recommendations
            - total_applied
            - total_measured
            - avg_confidence
            - avg_applied_confidence
            - application_rate
            
        ORM Refactored: Sprint 1.6.1 Task 2.1.8
        """
        from src.optimizer_v3.database.models import AIRecommendation
        from sqlalchemy import func, case
        
        try:
            # Build ORM aggregation query
            result = self.session.query(
                func.count(AIRecommendation.recommendation_id).label('total_recommendations'),
                func.count(case((AIRecommendation.applied == True, 1))).label('total_applied'),
                func.count(case((AIRecommendation.metrics_after != None, 1))).label('total_measured'),
                func.avg(AIRecommendation.combined_confidence).label('avg_confidence'),
                func.avg(case((AIRecommendation.applied == True, AIRecommendation.combined_confidence))).label('avg_applied_confidence')
            ).one()
            
            stats = {
                'total_recommendations': result.total_recommendations or 0,
                'total_applied': result.total_applied or 0,
                'total_measured': result.total_measured or 0,
                'avg_confidence': float(result.avg_confidence) if result.avg_confidence else 0.0,
                'avg_applied_confidence': float(result.avg_applied_confidence) if result.avg_applied_confidence else 0.0
            }
            
            # Calculate application rate
            stats['application_rate'] = (
                stats['total_applied'] / stats['total_recommendations'] 
                if stats['total_recommendations'] > 0 else 0.0
            )
            
            return stats
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get effectiveness stats: {e}")
            return {
                'total_recommendations': 0,
                'total_applied': 0,
                'total_measured': 0,
                'avg_confidence': 0.0,
                'avg_applied_confidence': 0.0,
                'application_rate': 0.0
            }
