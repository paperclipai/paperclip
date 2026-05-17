"""
Database Models for Optimizer V3
Task 0.4: Database Models with NautilusTrader Integration

All models use NautilusTrader types stored as strings for precision:
- Quantity -> String
- Price -> String  
- Money -> String
- Enums -> Native PostgreSQL Enums
"""

import uuid
from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Text, Index, Numeric, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.sql import func

Base = declarative_base()


class OptimizationRun(Base):
    """
    Record of optimizer execution runs
    Tracks each optimization session with configuration and results
    """
    __tablename__ = 'optimization_runs'
    
    run_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id = Column(String(255), nullable=False, index=True)
    strategy_name = Column(String(255), nullable=False)
    strategy_config = Column(JSONB, nullable=False)
    
    # Execution metadata
    start_time = Column(DateTime, nullable=False, default=datetime.utcnow)
    end_time = Column(DateTime)
    status = Column(String(50), nullable=False, default='running')  # running, completed, failed, cancelled
    error_message = Column(Text)
    
    # Configuration used
    backtest_config = Column(JSONB, nullable=False)
    optimization_params = Column(JSONB, nullable=False)
    
    # Results summary
    total_variations = Column(Integer)
    completed_variations = Column(Integer, default=0)
    failed_variations = Column(Integer, default=0)
    
    # Performance metrics
    best_sharpe_ratio = Column(Float)
    best_profit_factor = Column(Float)
    best_win_rate = Column(Float)
    best_total_pnl = Column(String(50))  # Money type stored as string
    
    # Timestamps
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_opt_runs_strategy_status', 'strategy_id', 'status'),
        Index('idx_opt_runs_start_time', 'start_time'),
    )


class StrategyVariation(Base):
    """
    Individual strategy variations tested during optimization
    Each row represents one parameter combination tested
    """
    __tablename__ = 'strategy_variations'
    
    variation_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    variation_number = Column(Integer, nullable=False)
    
    # Parameter combination
    parameters = Column(JSONB, nullable=False)
    parameter_hash = Column(String(64), nullable=False, index=True)  # MD5 hash for deduplication
    
    # Execution status
    status = Column(String(50), nullable=False, default='pending')  # pending, running, completed, failed
    start_time = Column(DateTime)
    end_time = Column(DateTime)
    execution_time_seconds = Column(Float)
    error_message = Column(Text)
    
    # Performance Results (all NautilusTrader types as strings)
    total_pnl = Column(String(50))  # Money
    total_return_pct = Column(Float)
    sharpe_ratio = Column(Float)
    sortino_ratio = Column(Float)
    profit_factor = Column(Float)
    win_rate = Column(Float)
    max_drawdown = Column(String(50))  # Money
    max_drawdown_pct = Column(Float)
    
    # Trade statistics
    total_trades = Column(Integer)
    winning_trades = Column(Integer)
    losing_trades = Column(Integer)
    avg_win = Column(String(50))  # Money
    avg_loss = Column(String(50))  # Money
    largest_win = Column(String(50))  # Money
    largest_loss = Column(String(50))  # Money
    
    # Risk metrics
    var_95 = Column(Float)
    cvar_95 = Column(Float)
    calmar_ratio = Column(Float)
    
    # Exit condition statistics (Sprint 1.8 Task 1.8.20)
    exit_condition_triggers = Column(Integer, default=0)
    
    # Ranking score (composite metric for sorting)
    ranking_score = Column(Float, index=True)
    
    # Timestamps
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_variations_run_ranking', 'run_id', 'ranking_score'),
        Index('idx_variations_status', 'status'),
    )


class SignalEvent(Base):
    """
    Signal events recorded during strategy execution
    For signal intelligence and pattern analysis
    """
    __tablename__ = 'signal_events'
    
    event_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    variation_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    
    # Event details
    timestamp = Column(DateTime, nullable=False, index=True)
    signal_name = Column(String(255), nullable=False, index=True)
    signal_type = Column(String(50), nullable=False)  # entry, exit, filter, exit_condition (Sprint 1.8 Task 1.8.19)
    signal_direction = Column(String(20))  # long, short, neutral
    
    # Market context
    instrument_id = Column(String(100), nullable=False)
    price = Column(String(50), nullable=False)  # Price type
    bar_number = Column(Integer)
    
    # Signal metadata
    signal_strength = Column(Float)
    confidence = Column(Float)
    signal_metadata = Column(JSONB)  # Renamed from 'metadata' (reserved keyword)
    
    # Outcome tracking (filled after trade completes)
    led_to_trade = Column(Boolean, default=False)
    trade_result = Column(String(20))  # win, loss, breakeven
    trade_pnl = Column(String(50))  # Money type
    
    created_at = Column(DateTime, server_default=func.now())
    
    __table_args__ = (
        Index('idx_signal_events_signal_timestamp', 'signal_name', 'timestamp'),
        Index('idx_signal_events_trade_result', 'led_to_trade', 'trade_result'),
    )


class SignalMetrics(Base):
    """
    Aggregated metrics for signal performance analysis
    Updated periodically to track signal effectiveness
    """
    __tablename__ = 'signal_metrics'
    
    metric_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    signal_name = Column(String(255), nullable=False, index=True)
    
    # Time window for metrics
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    
    # Occurrence statistics
    total_occurrences = Column(Integer, nullable=False, default=0)
    trades_triggered = Column(Integer, nullable=False, default=0)
    trigger_rate = Column(Float)  # trades_triggered / total_occurrences
    
    # Performance statistics
    winning_trades = Column(Integer, default=0)
    losing_trades = Column(Integer, default=0)
    win_rate = Column(Float)
    avg_pnl = Column(String(50))  # Money
    total_pnl = Column(String(50))  # Money
    profit_factor = Column(Float)
    
    # Context
    best_market_condition = Column(String(100))
    worst_market_condition = Column(String(100))
    best_timeframe = Column(String(50))
    
    # Timestamps
    calculated_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_signal_metrics_name_dates', 'signal_name', 'start_date', 'end_date'),
        Index('idx_signal_metrics_win_rate', 'win_rate'),
    )


class TrainingSession(Base):
    """
    ML training sessions for signal generation
    Tracks training runs and model performance
    """
    __tablename__ = 'training_sessions'
    
    session_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_name = Column(String(255), nullable=False)
    
    # Training configuration
    model_type = Column(String(100), nullable=False)  # xgboost, lightgbm, etc.
    training_config = Column(JSONB, nullable=False)
    feature_set = Column(JSONB, nullable=False)
    
    # Data window
    training_start_date = Column(DateTime, nullable=False)
    training_end_date = Column(DateTime, nullable=False)
    validation_start_date = Column(DateTime)
    validation_end_date = Column(DateTime)
    
    # Training results
    training_accuracy = Column(Float)
    validation_accuracy = Column(Float)
    training_loss = Column(Float)
    validation_loss = Column(Float)
    
    # Model performance
    precision = Column(Float)
    recall = Column(Float)
    f1_score = Column(Float)
    auc_roc = Column(Float)
    
    # Model artifacts
    model_path = Column(String(500))
    feature_importance = Column(JSONB)
    
    # Status
    status = Column(String(50), nullable=False, default='pending')
    start_time = Column(DateTime)
    end_time = Column(DateTime)
    training_time_seconds = Column(Float)
    error_message = Column(Text)
    
    # Timestamps
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    __table_args__ = (
        Index('idx_training_sessions_status', 'status'),
        Index('idx_training_sessions_dates', 'training_start_date', 'training_end_date'),
    )


class SessionState(Base):
    """
    Persistent state for long-running optimization sessions
    Enables resume capability and progress tracking
    """
    __tablename__ = 'session_states'
    
    state_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id = Column(UUID(as_uuid=True), nullable=False, unique=True, index=True)
    
    # Session state
    current_variation = Column(Integer, nullable=False, default=0)
    total_variations = Column(Integer, nullable=False)
    progress_percentage = Column(Float, default=0.0)
    
    # Checkpoint data
    checkpoint_data = Column(JSONB)  # Serialized state for resume
    last_processed_params = Column(JSONB)
    completed_param_hashes = Column(JSONB)  # list of completed parameter hashes
    
    # Resource usage tracking
    cpu_usage_avg = Column(Float)
    memory_usage_avg = Column(Float)
    disk_io_mb = Column(Float)
    
    # Timing estimates
    avg_variation_time_seconds = Column(Float)
    estimated_time_remaining_seconds = Column(Float)
    estimated_completion_time = Column(DateTime)
    
    # Timestamps
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    last_checkpoint_at = Column(DateTime)


class BacktestResult(Base):
    """
    Detailed backtest results with full NautilusTrader integration
    One row per completed backtest execution
    """
    __tablename__ = 'backtest_results'
    
    result_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    variation_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    run_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    
    # Backtest metadata
    start_time = Column(DateTime, nullable=False, index=True)
    end_time = Column(DateTime, nullable=False)
    instrument_id = Column(String(100), nullable=False)
    
    # Configuration snapshot
    backtest_config = Column(JSONB, nullable=False)
    strategy_params = Column(JSONB, nullable=False)
    
    # Full performance statistics (NautilusTrader format)
    statistics = Column(JSONB, nullable=False)
    
    # Trade list
    trades = Column(JSONB)  # List of all trades with full details
    
    # Equity curve
    equity_curve = Column(JSONB)  # Time series of account value
    
    # Generated by Nautilus
    nautilus_report = Column(JSONB)
    
    # File references
    results_file_path = Column(String(500))
    chart_file_path = Column(String(500))
    
    created_at = Column(DateTime, server_default=func.now())
    
    __table_args__ = (
        Index('idx_backtest_results_run_variation', 'run_id', 'variation_id'),
        Index('idx_backtest_results_dates', 'start_time', 'end_time'),
    )


# ==============================================================================
# SPRINT 1.6.1 ORM MODELS - Strategy Versioning & AI Recommendations
# ==============================================================================

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship


class Strategy(Base):
    """
    Sprint 1.6.1 Task 1.6.1.ORM.1
    Parent strategy table linking all versions, recommendations, and test results.
    
    Institutional-grade implementation with:
    - Cascade deletes for all child records
    - Proper indexing for query performance
    - Timestamp tracking for audit trail
    """
    __tablename__ = 'strategies'
    
    # Primary identification
    strategy_id = Column(String(255), primary_key=True)
    name = Column(String(255), nullable=False)
    
    # Timestamps for audit trail
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    
    # Relationships with cascade deletes
    versions = relationship(
        "StrategyVersion",
        back_populates="strategy",
        cascade="all, delete-orphan",
        order_by="StrategyVersion.version_number"
    )
    recommendations = relationship(
        "AIRecommendation",
        back_populates="strategy",
        cascade="all, delete-orphan"
    )
    test_results = relationship(
        "StrategyTestResult",
        back_populates="strategy",
        cascade="all, delete-orphan"
    )
    
    __table_args__ = (
        Index('idx_strategies_name', 'name'),
        Index('idx_strategies_created_at', 'created_at'),
    )
    
    def __repr__(self):
        return f"<Strategy(strategy_id='{self.strategy_id}', name='{self.name}')>"


class StrategyVersion(Base):
    """
    Sprint 1.6.1 Task 1.6.1.ORM.2
    Versioned strategy configurations with complete strategy definition.
    
    Stores:
    - Complete strategy configuration in JSONB columns
    - Backtest results and metrics
    - Version control metadata (git hash, notes, tags)
    - Config hash for duplicate detection
    
    Used by:
    - Sprint 1.8 Exit Conditions (exit_conditions JSONB)
    - Sprint 2.2 Signal Intelligence (signals JSONB)
    """
    __tablename__ = 'strategy_versions'
    
    # Primary identification
    version_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id = Column(
        String(255),
        ForeignKey('strategies.strategy_id', ondelete='CASCADE'),
        nullable=False
    )
    version_number = Column(Integer, nullable=False)
    
    # Strategy metadata
    name = Column(String(255), nullable=False)
    description = Column(Text)
    
    # Complete strategy definition (JSONB for flexibility)
    blocks = Column(JSONB, nullable=False, default=list)
    signals = Column(JSONB, nullable=False, default=dict)
    parameters = Column(JSONB, nullable=False, default=dict)
    entry_conditions = Column(JSONB, nullable=False, default=dict)
    exit_conditions = Column(JSONB, nullable=False, default=list)  # Sprint 1.8
    risk_management = Column(JSONB, nullable=False, default=dict)
    
    # Backtest configuration and results
    backtest_config = Column(JSONB, nullable=False, default=dict)
    backtest_results = Column(JSONB)
    metrics = Column(JSONB)
    trades = Column(JSONB)
    equity_curve = Column(JSONB)
    
    # Version control and tracking
    timestamp = Column(DateTime, nullable=False, server_default=func.now())
    git_commit_hash = Column(String(40))
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    created_by = Column(String(100))
    notes = Column(Text)
    tags = Column(JSONB, default=list)
    
    # Duplicate detection
    config_hash = Column(String(64), index=True)
    
    # Validation status (Sprint 1.9 - persisted validation state)
    validation_status = Column(String(20), default='Un-Validated')  # Un-Validated, Pass, Fail
    validation_timestamp = Column(DateTime)  # When last validated
    
    # Strategy type (Sprint 1.9 - Bullish/Bearish classification)
    strategy_type = Column(String(20), default='Bullish')  # Bullish, Bearish
    
    # Relationships
    strategy = relationship("Strategy", back_populates="versions")
    block_versions = relationship(
        "StrategyBlockVersion",
        back_populates="version",
        cascade="all, delete-orphan"
    )
    recommendations = relationship(
        "AIRecommendation",
        back_populates="version",
        cascade="all, delete-orphan",
        foreign_keys="AIRecommendation.strategy_version_id"
    )
    test_results = relationship(
        "StrategyTestResult",
        back_populates="version",
        cascade="all, delete-orphan"
    )
    
    __table_args__ = (
        UniqueConstraint('strategy_id', 'version_number', name='uq_strategy_version'),
        Index('idx_strategy_versions_strategy', 'strategy_id'),
        Index('idx_strategy_versions_timestamp', 'timestamp'),
        Index('idx_strategy_versions_hash', 'config_hash'),
    )
    
    def __repr__(self):
        return f"<StrategyVersion(version_id='{self.version_id}', name='{self.name}', v{self.version_number})>"


class StrategyBlockVersion(Base):
    """
    Sprint 1.6.1 Task 1.6.1.ORM.3
    Block-level version tracking for granular change history.
    
    Tracks individual building blocks within strategy versions:
    - Block name and type
    - Signals and parameters
    - Logic type (AND/OR)
    - Sequence number for ordering
    """
    __tablename__ = 'strategy_block_versions'
    
    block_version_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    version_id = Column(
        UUID(as_uuid=True),
        ForeignKey('strategy_versions.version_id', ondelete='CASCADE'),
        nullable=False
    )
    
    # Block identification
    block_name = Column(String(255), nullable=False)
    block_type = Column(String(100), nullable=False)
    
    # Block configuration
    signals = Column(JSONB, nullable=False, default=list)
    parameters = Column(JSONB, nullable=False, default=dict)
    logic_type = Column(String(20), nullable=False, default='AND')  # AND/OR
    sequence_number = Column(Integer)
    
    # Timestamps
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    
    # Relationships
    version = relationship("StrategyVersion", back_populates="block_versions")
    
    __table_args__ = (
        Index('idx_block_versions_version', 'version_id'),
        Index('idx_block_versions_name', 'block_name'),
    )
    
    def __repr__(self):
        return f"<StrategyBlockVersion(block_name='{self.block_name}', type='{self.block_type}')>"


class AIRecommendation(Base):
    """
    Sprint 1.6.1 Task 1.6.1.ORM.4
    AI recommendation tracking with full metadata.
    
    Stores:
    - Recommendation details (type, config, reasoning)
    - Confidence scores
    - Application tracking (applied, metrics before/after)
    - Link to strategy version
    """
    __tablename__ = 'ai_recommendations'
    
    recommendation_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id = Column(
        String(255),
        ForeignKey('strategies.strategy_id', ondelete='CASCADE'),
        nullable=False
    )
    strategy_version_id = Column(
        UUID(as_uuid=True),
        ForeignKey('strategy_versions.version_id', ondelete='CASCADE'),
        nullable=False,
        name='version_id',
    )
    strategy_version = Column(String(50))  # Display version string 'v1', 'v2', etc.
    
    # Recommendation details
    timestamp = Column(DateTime, nullable=False, server_default=func.now())
    recommendation_type = Column(String(50), nullable=False)  # ADD_BLOCK, ADJUST_PARAMETER, etc.
    block_name = Column(String(255))
    signal_name = Column(String(255))
    parameter_name = Column(String(255))
    configuration = Column(JSONB)
    reasoning = Column(Text, nullable=False)
    expected_impact = Column(JSONB)
    combined_confidence = Column(Float)
    root_cause = Column(Text)
    warnings = Column(JSONB)
    
    # AI metadata
    ai_enhanced = Column(Boolean, default=False)
    
    # Application tracking
    applied = Column(Boolean, default=False)
    applied_at = Column(DateTime)
    metrics_before = Column(JSONB)
    metrics_after = Column(JSONB)
    
    # Timestamps
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    
    # Relationships
    strategy = relationship("Strategy", back_populates="recommendations")
    version = relationship(
        "StrategyVersion",
        back_populates="recommendations",
        foreign_keys=[strategy_version_id]
    )
    
    __table_args__ = (
        Index('idx_ai_recommendations_strategy', 'strategy_id'),
        Index('idx_ai_recommendations_version', 'version_id'),
        Index('idx_ai_recommendations_timestamp', 'timestamp'),
        Index('idx_ai_recommendations_type', 'recommendation_type'),
        Index('idx_ai_recommendations_applied', 'applied'),
    )
    
    def __repr__(self):
        return f"<AIRecommendation(type='{self.recommendation_type}', applied={self.applied})>"


class StrategyTestResult(Base):
    """
    Sprint 1.6.1 Task 1.6.1.ORM.5
    Strategy test results history with complete metrics.
    
    Stores:
    - Test type (backtest, forward_test, paper_trade, live)
    - Complete metrics and trade history
    - Equity curve data
    - AI recommendations linked to results
    """
    __tablename__ = 'strategy_test_results'
    
    result_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id = Column(
        String(255),
        ForeignKey('strategies.strategy_id', ondelete='CASCADE'),
        nullable=False
    )
    version_id = Column(
        UUID(as_uuid=True),
        ForeignKey('strategy_versions.version_id', ondelete='CASCADE'),
        nullable=False
    )
    
    # Test configuration
    test_type = Column(String(50), nullable=False)  # backtest, forward_test, paper_trade, live
    test_config = Column(JSONB, nullable=False, default=dict)
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    
    # Performance metrics
    total_return_pct = Column(Float)
    sharpe_ratio = Column(Float)
    max_drawdown_pct = Column(Float)
    win_rate = Column(Float)
    profit_factor = Column(Float)
    total_trades = Column(Integer)
    
    # Complete results
    metrics = Column(JSONB, nullable=False, default=dict)
    trades = Column(JSONB)
    equity_curve = Column(JSONB)
    risk_metrics = Column(JSONB)  # Sprint 1.6.1 - Risk metrics (VaR, CVaR, etc.)
    ai_recommendations = Column(JSONB)  # Linked recommendations
    exit_condition_results = Column(JSONB)  # Sprint 1.8 Task 1.8.18 - Exit condition trigger details
    
    # Execution tracking
    errors = Column(JSONB)  # Sprint 1.6.1 - Error log during test execution
    warnings = Column(JSONB)  # Sprint 1.6.1 - Warning log during test execution
    notes = Column(Text)  # Sprint 1.6.1 - Additional notes about test

    # Timestamps
    timestamp = Column(DateTime, nullable=False, server_default=func.now())
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    
    # Relationships
    strategy = relationship("Strategy", back_populates="test_results")
    version = relationship("StrategyVersion", back_populates="test_results")
    
    __table_args__ = (
        Index('idx_test_results_strategy', 'strategy_id'),
        Index('idx_test_results_version', 'version_id'),
        Index('idx_test_results_timestamp', 'timestamp'),
        Index('idx_test_results_test_type', 'test_type'),
    )
    
    def __repr__(self):
        return f"<StrategyTestResult(type='{self.test_type}', sharpe={self.sharpe_ratio})>"


# ==============================================================================
# SPRINT 1.9 ORM MODEL - Validation Report Persistence
# ==============================================================================

class ValidationReportDB(Base):
    """
    Sprint 1.9 Task 1.9.31
    Validation report persistence for trending analysis.
    
    Tracks validation history for each strategy version:
    - Validation results (pass/fail)
    - Issue counts by severity
    - Complete issues list (JSONB)
    - Complexity metrics
    
    Used for:
    - Tracking validation issues over time
    - Identifying recurring problems
    - Complexity trend analysis
    """
    __tablename__ = 'validation_reports'
    
    report_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id = Column(
        String(255),
        ForeignKey('strategies.strategy_id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )
    version_id = Column(
        UUID(as_uuid=True),
        ForeignKey('strategy_versions.version_id', ondelete='CASCADE'),
        nullable=False,
        index=True
    )
    
    # Validation metadata
    timestamp = Column(DateTime, nullable=False, server_default=func.now())
    validation_level = Column(String(50), nullable=False, default='INSTITUTIONAL')
    
    # Overall results
    is_valid = Column(Boolean, nullable=False)
    total_issues = Column(Integer, default=0)
    
    # Issue counts by severity
    critical_count = Column(Integer, default=0)
    error_count = Column(Integer, default=0)
    warning_count = Column(Integer, default=0)
    notice_count = Column(Integer, default=0)
    info_count = Column(Integer, default=0)
    
    # Complete validation data (JSONB)
    issues = Column(JSONB, nullable=False, default=list)  # List[ValidationIssue as dict]
    complexity_metrics = Column(JSONB, nullable=False, default=dict)
    strategy_summary = Column(JSONB, default=dict)
    direction_analysis = Column(JSONB)  # Strategy direction analysis
    exit_strategy_analysis = Column(JSONB)  # Exit condition analysis
    timing_conflicts = Column(JSONB, default=list)  # Timeline data
    recheck_chains = Column(JSONB, default=list)  # RECHECK analysis
    
    # Timestamps
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    
    __table_args__ = (
        Index('idx_validation_reports_strategy', 'strategy_id'),
        Index('idx_validation_reports_version', 'version_id'),
        Index('idx_validation_reports_timestamp', 'timestamp'),
        Index('idx_validation_reports_is_valid', 'is_valid'),
        Index('idx_validation_reports_strategy_timestamp', 'strategy_id', 'timestamp'),
    )
    
    def __repr__(self):
        status = "PASSED" if self.is_valid else "FAILED"
        return f"<ValidationReportDB(strategy_id='{self.strategy_id}', status='{status}', issues={self.total_issues})>"


# ==============================================================================
# AI CONSULTANT AUDIT
# ==============================================================================

class AiConsultantAudit(Base):
    """
    Compliance audit log for all AI Consultant activity.

    id has a Python-side default (uuid.uuid4) AND a server_default (gen_random_uuid())
    so the column is safe for both ORM inserts and raw SQL inserts.
    """
    __tablename__ = "ai_consultant_audit"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id = Column(UUID(as_uuid=True), nullable=False)
    event_type = Column(Text, nullable=False)
    timestamp = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    user_id = Column(Text, nullable=True)
    strategy_id = Column(Text, nullable=True)
    payload = Column(JSONB, nullable=False)
    token_cost_usd = Column(Numeric(precision=18, scale=8), nullable=True)

    __table_args__ = (
        Index("idx_ai_audit_session_id", "session_id"),
        Index("idx_ai_audit_event_type", "event_type"),
        Index("idx_ai_audit_timestamp", "timestamp"),
    )

    def __repr__(self):
        return f"<AiConsultantAudit(id='{self.id}', event_type='{self.event_type}')>"

# ==============================================================================
# ADR-0002 TRACEABILITY SCHEMA
# Requirement → TestCase → Issue traceability layer
# ==============================================================================


class TraceRequirement(Base):
    __tablename__ = "trace_requirements"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identifier = Column(String(50), nullable=False, unique=True)
    title = Column(String(500), nullable=False)
    description = Column(Text, nullable=True)
    status = Column(String(30), nullable=False)
    priority = Column(String(20), nullable=True)
    labels = Column(JSONB, nullable=True)
    source = Column(String(30), nullable=False)
    paperclip_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    metadata_ = Column("metadata", JSONB, nullable=True)

    __table_args__ = (
        Index("idx_trace_requirements_status", "status"),
        Index("idx_trace_requirements_paperclip_id", "paperclip_id"),
    )

    def __repr__(self):
        return f"<TraceRequirement(identifier='{self.identifier}', status='{self.status}')>"


class TraceTestCase(Base):
    __tablename__ = "trace_test_cases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identifier = Column(String(300), nullable=False, unique=True)
    test_file = Column(String(500), nullable=False)
    test_function = Column(String(300), nullable=False)
    test_class = Column(String(300), nullable=True)
    markers = Column(JSONB, nullable=True)
    source = Column(String(30), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    tags = Column(JSONB, nullable=True)
    language = Column(String(20), nullable=False, server_default=text("'python'"))
    component = Column(String(200), nullable=True)

    __table_args__ = (
        Index("idx_trace_test_cases_test_file", "test_file"),
        Index("idx_trace_test_cases_component", "component"),
    )

    def __repr__(self):
        return f"<TraceTestCase(identifier='{self.identifier}', file='{self.test_file}')>"


class TraceIssue(Base):
    __tablename__ = "trace_issues"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identifier = Column(String(50), nullable=False, unique=True)
    title = Column(String(500), nullable=False)
    issue_type = Column(String(30), nullable=False)
    status = Column(String(30), nullable=False)
    paperclip_id = Column(UUID(as_uuid=True), nullable=True)
    labels = Column(JSONB, nullable=True)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("trace_issues.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_trace_issues_paperclip_id", "paperclip_id"),
        Index("idx_trace_issues_issue_type", "issue_type"),
        Index("idx_trace_issues_status", "status"),
    )

    parent = relationship("TraceIssue", remote_side="TraceIssue.id", backref="children")

    def __repr__(self):
        return f"<TraceIssue(identifier='{self.identifier}', type='{self.issue_type}')>"


class TraceLink(Base):
    __tablename__ = "trace_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requirement_id = Column(UUID(as_uuid=True), ForeignKey("trace_requirements.id"), nullable=True)
    test_case_id = Column(UUID(as_uuid=True), ForeignKey("trace_test_cases.id"), nullable=True)
    issue_id = Column(UUID(as_uuid=True), ForeignKey("trace_issues.id"), nullable=True)
    link_type = Column(String(30), nullable=False)
    direction = Column(String(10), nullable=False)
    confidence = Column(Float, nullable=False)
    metadata_ = Column("metadata", JSONB, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_by = Column(String(100), nullable=True)

    __table_args__ = (
        UniqueConstraint("requirement_id", "test_case_id", "issue_id", "link_type",
                         name="uq_trace_link_edge"),
        Index("idx_trace_links_requirement_id", "requirement_id"),
        Index("idx_trace_links_test_case_id", "test_case_id"),
        Index("idx_trace_links_issue_id", "issue_id"),
        Index("idx_trace_links_link_type", "link_type"),
    )

    requirement = relationship("TraceRequirement", backref="links")
    test_case = relationship("TraceTestCase", backref="links")
    issue = relationship("TraceIssue", backref="links")

    def __repr__(self):
        return (
            f"<TraceLink(type='{self.link_type}', "
            f"confidence={self.confidence}, "
            f"active={self.is_active})>"
        )

