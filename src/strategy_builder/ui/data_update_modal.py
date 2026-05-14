"""
Data Update Modal - Strategy Builder Startup Check

Shows on Strategy Builder launch to:
- Check for data gaps (LakeAPI cutoff → current)
- Offer to download missing data from Binance
- Display progress during update
- Safe: Only downloads to data/binance/ (never touches LakeAPI!)

Author: Strategy Builder Team
Date: 2026-01-17
"""

from datetime import datetime, timedelta, timezone
from typing import Optional
import pandas as pd
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QProgressBar, QTextEdit, QGroupBox
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt5.QtGui import QFont

# Import UnifiedDataManager - THE ONLY DATA SOURCE!
from src.data_manager.unified_manager import UnifiedDataManager, DataSource
# Import centralized styles
from src.strategy_builder.ui.styles import (
    get_main_stylesheet, get_panel_title_stylesheet, 
    get_label_style, get_status_label_style,
    get_primary_button_stylesheet, get_secondary_button_stylesheet
)

import logging
logger = logging.getLogger(__name__)



class DataUpdateThread(QThread):
    """
    Background thread for downloading data from Binance
    
    INSTITUTIONAL FIX: Implements retry logic for delayed Binance candles
    - Binance may not have latest 15min candle ready immediately
    - Retries up to 3 times with exponential backoff (10s, 20s, 30s)
    - Ensures we get the freshest possible data
    
    Signals:
        progress: (current, total, message) - Progress updates
        finished: (success, message) - Completion status
    """
    
    progress = pyqtSignal(int, int, str)
    finished = pyqtSignal(bool, str)
    
    def __init__(self, start_date: datetime, end_date: datetime):
        super().__init__()
        self.start_date = start_date
        self.end_date = end_date
        self.manager = UnifiedDataManager(mode='live')  # CRITICAL: Use 'live' mode for API updates!
        self.max_retries = 3
        self.retry_delays = [10, 20, 30]  # Seconds between retries
    
    def run(self):
        """
        Download missing data from Binance AND SAVE TO DISK
        
        INSTITUTIONAL FIX: Implements retry logic for delayed Binance candles
        """
        try:
            from pathlib import Path
            import time
            import requests as _requests

            self.progress.emit(0, 100, "Initializing Binance connection...")

            # BUG D FIX: Lightweight network readiness pre-check before the
            # first real klines call.  On some systems/boots the network stack
            # or DNS resolver is not ready immediately after the window is shown.
            # A failed ping here gives a descriptive error rather than an
            # empty klines response that looks like a data API failure.
            try:
                ping_resp = _requests.get(
                    "https://api.binance.com/api/v3/ping", timeout=3
                )
                ping_resp.raise_for_status()
                self.progress.emit(5, 100, "✅ Binance reachable — starting download...")
            except Exception as ping_exc:
                raise ConnectionError(
                    f"Binance API unreachable (network not ready?): {ping_exc}\n\n"
                    "Check your internet connection and try again."
                )
            
            # INSTITUTIONAL: Download with retry logic for delayed candles
            self.progress.emit(15, 100, "Downloading 15min bars from Binance (with retry logic)...")
            bars_15m = self._download_with_retry(
                timeframe='15m',
                start_date=self.start_date,
                end_date=self.end_date
            )
            
            self.progress.emit(40, 100, f"Downloaded {len(bars_15m)} bars (15min)")
            
            # INSTITUTIONAL: SAVE TO DISK via unified _save_binance_bars (dtype
            # normalization, cross-month guard, atomic write, read-back verify).
            self.progress.emit(45, 100, "Saving 15min bars to disk...")
            self.manager._save_binance_bars(bars_15m, '15m')

            # INSTITUTIONAL: Download 1h bars with retry logic
            self.progress.emit(60, 100, "Downloading 1h bars from Binance (with retry logic)...")
            bars_1h = self._download_with_retry(
                timeframe='1h',
                start_date=self.start_date,
                end_date=self.end_date
            )

            self.progress.emit(80, 100, f"Downloaded {len(bars_1h)} bars (1h)")

            # INSTITUTIONAL: SAVE TO DISK!
            self.progress.emit(85, 100, "Saving 1h bars to disk...")
            self.manager._save_binance_bars(bars_1h, '1h')

            # INSTITUTIONAL: Download 1d bars with retry logic
            self.progress.emit(88, 100, "Downloading 1d bars from Binance...")
            bars_1d = self._download_with_retry(
                timeframe='1d',
                start_date=self.start_date,
                end_date=self.end_date
            )
            self.progress.emit(92, 100, f"Downloaded {len(bars_1d)} bars (1d)")

            # INSTITUTIONAL: SAVE TO DISK!
            self.progress.emit(94, 100, "Saving 1d bars to disk...")
            self.manager._save_binance_bars(bars_1d, '1d')

            # Success!
            self.progress.emit(100, 100, "Download complete!")
            self.finished.emit(
                True,
                f"✅ Successfully updated!\n\n"
                f"15min bars: {len(bars_15m)} bars saved\n"
                f"1h bars: {len(bars_1h)} bars saved\n"
                f"1d bars: {len(bars_1d)} bars saved\n\n"
                f"Files saved to: data/binance/\n"
                f"Latest timestamp: {bars_15m['timestamp'].iloc[-1]}"
            )
            
        except Exception as e:
            self.finished.emit(
                False,
                f"❌ Download failed:\n\n{str(e)}\n\n"
                f"You can try again later or continue without update."
            )
    
    def _download_with_retry(self, timeframe: str, start_date: datetime, end_date: datetime) -> pd.DataFrame:
        """
        Download bars with retry logic for delayed Binance candles
        
        INSTITUTIONAL FIX: Binance may not have latest 15min candle ready immediately.
        This method retries up to 3 times with exponential backoff if data is stale.
        
        Args:
            timeframe: Bar timeframe ('15m', '1h', etc.)
            start_date: Start date
            end_date: End date
        
        Returns:
            DataFrame with bars (freshest possible)
        """
        import time
        
        last_error = None
        for attempt in range(self.max_retries + 1):
            # Reset client on each retry so a degraded connection is never reused
            if attempt > 0:
                self.manager.reset_client()

            # Download data
            bars = self.manager.get_bars(
                timeframe=timeframe,
                start_date=start_date,
                end_date=end_date,
                source=DataSource.BINANCE
            )

            # BUG A FIX: empty response triggers a retry, not an immediate raise
            if len(bars) == 0:
                last_error = f"No {timeframe} bars received from Binance (attempt {attempt + 1})"
                self.progress.emit(
                    0, 100,
                    f"⚠️  {timeframe} empty response on attempt {attempt + 1}/{self.max_retries + 1} — retrying..."
                )
                if attempt < self.max_retries:
                    retry_delay = self.retry_delays[attempt]
                    self.progress.emit(
                        0, 100,
                        f"⏳ Waiting {retry_delay}s before retry {attempt + 2}/{self.max_retries + 1}..."
                    )
                    time.sleep(retry_delay)
                    continue
                else:
                    raise ValueError(last_error)

            # Check freshness (how old is the latest candle?)
            # Candle timestamps are tz-aware UTC after BTCAAAAA-816.
            # Must compare against datetime.now(timezone.utc) to avoid TypeError.
            latest_candle = pd.to_datetime(bars['timestamp'].iloc[-1], utc=True)
            delay_minutes = (datetime.now(timezone.utc) - latest_candle).total_seconds() / 60
            
            # Per-timeframe staleness thresholds
            if timeframe == '15m':
                acceptable_delay = 20
            elif timeframe == '1h':
                acceptable_delay = 65
            else:  # 1d and others
                acceptable_delay = 1500
            
            if delay_minutes <= acceptable_delay:
                # Data is fresh enough!
                self.progress.emit(
                    0, 100,
                    f"✅ {timeframe} data fresh ({delay_minutes:.1f} min delay) - attempt {attempt + 1}"
                )
                return bars
            
            # Data is stale - retry if we have attempts left
            if attempt < self.max_retries:
                retry_delay = self.retry_delays[attempt]
                self.progress.emit(
                    0, 100,
                    f"⏳ {timeframe} data stale ({delay_minutes:.0f} min delay) - "
                    f"waiting {retry_delay}s before retry {attempt + 2}/{self.max_retries + 1}..."
                )
                time.sleep(retry_delay)
            else:
                # Final attempt failed, but return what we have
                self.progress.emit(
                    0, 100,
                    f"⚠️  {timeframe} still stale after {self.max_retries} retries ({delay_minutes:.0f} min delay) - using anyway"
                )
                return bars
        
        return bars


class DataUpdateModal(QDialog):
    """
    Modal dialog for checking and updating data
    
    INSTITUTIONAL FIX: Auto-updates if gaps detected, auto-closes after 3 seconds
    
    Shown on Strategy Builder startup to ensure data is current.
    
    Behavior:
    - If gaps detected: Auto-updates, then closes after 3s
    - If data complete: Shows "all good" message, closes after 3s
    """
    
    def __init__(self, parent=None, auto_mode: bool = True):
        """
        Initialize the data update modal
        
        Args:
            parent: Parent widget
            auto_mode: If True (startup), auto-update and auto-close. 
                      If False (manual), require user interaction.
        """
        super().__init__(parent)
        
        self.manager = UnifiedDataManager(mode='live')  # CRITICAL: Use 'live' mode for API updates!
        self.update_thread: Optional[DataUpdateThread] = None
        self.gap_days = 0
        self.lakeapi_end: Optional[datetime] = None
        self.current_time: Optional[datetime] = None
        self.has_gaps = False
        self.auto_started = False  # Track if we auto-started update
        self.auto_mode = auto_mode  # True = startup (auto), False = manual (no auto)
        
        # Countdown timer for auto-close (updates every second)
        self.countdown_seconds = 3
        self.countdown_timer = QTimer()
        self.countdown_timer.timeout.connect(self._update_countdown)
        self.original_status_text = ""  # Store original message
        
        # Retry logic for failed updates
        self.retry_count = 0
        self.max_retries = 3
        self.retry_delay = 5  # seconds
        self.retry_timer = QTimer()
        self.retry_timer.timeout.connect(self._retry_update)
        
        self._init_ui()
        self._check_data_gap()
    
    def _init_ui(self):
        """Initialize the user interface"""
        self.setWindowTitle("BTC Trade Engine - Data Update Check")
        
        # Make dialog moveable and independent (30% bigger)
        # Use Window flag instead of Dialog to allow dragging
        self.setWindowFlags(Qt.Window | Qt.WindowTitleHint | Qt.WindowCloseButtonHint | Qt.WindowStaysOnTopHint)
        self.setModal(True)  # Keep modal behavior but allow dragging
        
        # MASSIVE to avoid scrolling - institutional grade (90px taller total)
        self.setMinimumWidth(1400)
        self.setMinimumHeight(1090)
        self.resize(1400, 1090)
        
        # Apply centralized dark theme stylesheet
        self.setStyleSheet(get_main_stylesheet())
        
        layout = QVBoxLayout()
        layout.setSpacing(15)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Header with centralized styling
        header = QLabel("📊 Historical Data Update Check")
        header_font = QFont()
        header_font.setBold(True)
        header_font.setPointSize(14)
        header.setFont(header_font)
        header.setStyleSheet(get_panel_title_stylesheet())
        layout.addWidget(header)
        
        # Status group
        status_group = QGroupBox("Data Status")
        status_group.setMaximumHeight(100)  # Limit panel height for compact appearance
        status_layout = QVBoxLayout()
        status_layout.setSpacing(0)  # No spacing between elements
        status_layout.setContentsMargins(10, 0, 10, 10)  # Zero top margin for tight fit
        
        self.status_label = QLabel("Checking data availability...")
        self.status_label.setWordWrap(True)
        self.status_label.setAlignment(Qt.AlignCenter)  # Center text vertically and horizontally
        status_layout.addWidget(self.status_label)
        
        status_group.setLayout(status_layout)
        layout.addWidget(status_group)
        
        # Details text
        details_group = QGroupBox("Details")
        details_layout = QVBoxLayout()
        
        self.details_text = QTextEdit()
        self.details_text.setReadOnly(True)  
        self.details_text.setMinimumHeight(700)  # EXTRA tall - ZERO scrolling
        details_layout.addWidget(self.details_text)
        
        details_group.setLayout(details_layout)
        layout.addWidget(details_group)
        
        # Progress bar (initially hidden)
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)
        
        # Progress message with centralized styling
        self.progress_label = QLabel("")
        self.progress_label.setVisible(False)
        self.progress_label.setStyleSheet(get_label_style('info') + " font-style: italic;")
        layout.addWidget(self.progress_label)
        
        layout.addStretch()
        
        # Buttons
        buttons_layout = QHBoxLayout()
        buttons_layout.addStretch()
        
        self.skip_button = QPushButton("⏭️ Skip for Now")
        self.skip_button.setMinimumWidth(150)
        self.skip_button.setMinimumHeight(40)
        self.skip_button.setStyleSheet(get_secondary_button_stylesheet())
        self.skip_button.setToolTip("Skip the data update and continue to the Strategy Builder with existing data")
        self.skip_button.clicked.connect(self.reject)
        buttons_layout.addWidget(self.skip_button)
        
        self.update_button = QPushButton("📥 Update Data")
        self.update_button.setMinimumWidth(150)
        self.update_button.setMinimumHeight(40)
        self.update_button.setStyleSheet(get_primary_button_stylesheet())
        self.update_button.setToolTip("Download missing BTC/USDT bars from Binance to fill detected data gaps")
        self.update_button.clicked.connect(self._start_update)
        self.update_button.setEnabled(False)
        buttons_layout.addWidget(self.update_button)
        
        self.close_button = QPushButton("✅ Continue")
        self.close_button.setMinimumWidth(150)
        self.close_button.setMinimumHeight(40)
        self.close_button.setStyleSheet(get_primary_button_stylesheet())
        self.close_button.setToolTip("Data is up to date — continue to the Strategy Builder")
        self.close_button.clicked.connect(self.accept)
        self.close_button.setVisible(False)
        buttons_layout.addWidget(self.close_button)
        
        layout.addLayout(buttons_layout)
        
        self.setLayout(layout)
    
    def _check_data_gap(self):
        """Check for gaps across ALL data types"""
        try:
            # --- Fast path: skip download if Binance OHLCV is already current ---
            # If the last 15m bar on disk is within 1 candle period + 2 minutes of
            # now (UTC), data is current and we should not run the download flow.
            # This avoids triggering a Binance API call on every startup when the
            # system has been running continuously or restarted within 1 cycle.
            if self.auto_mode:
                try:
                    last_15m = self.manager.get_last_bar_timestamp('15m')
                    last_1h = self.manager.get_last_bar_timestamp('1h')

                    if last_15m is not None and last_1h is not None:
                        now = datetime.now(timezone.utc)
                        staleness_15m = (now - last_15m.replace(tzinfo=timezone.utc)).total_seconds()
                        staleness_1h = (now - last_1h.replace(tzinfo=timezone.utc)).total_seconds()
                        # 15m candle + 2 min grace = 17 min = 1020s
                        # 1h candle + 2 min grace = 62 min = 3720s
                        if staleness_15m <= 1020 and staleness_1h <= 3720:
                            logger.info(
                                f"[DataUpdateModal] Data current — last 15m bar "
                                f"{staleness_15m:.0f}s ago, last 1h bar {staleness_1h:.0f}s ago, "
                                f"skipping startup download"
                            )
                            self.status_label.setText(
                                f"✅ Data current — last 15m bar {int(staleness_15m//60)}m "
                                f"{int(staleness_15m%60)}s ago"
                            )
                            self.status_label.setStyleSheet(get_status_label_style('success'))
                            self.details_text.setText(
                                f"✅ Data is up to date.\n\n"
                                f"Last 15m bar: {last_15m.strftime('%Y-%m-%d %H:%M:%S')} UTC\n"
                                f"Age: {int(staleness_15m//60)}m {int(staleness_15m%60)}s\n\n"
                                f"Last 1h bar: {last_1h.strftime('%Y-%m-%d %H:%M:%S')} UTC\n"
                                f"Age: {int(staleness_1h//60)}m {int(staleness_1h%60)}s\n\n"
                                f"Skipping startup download — proceeding directly to live update mode."
                            )
                            # Close immediately with no countdown in auto mode
                            QTimer.singleShot(500, self.accept)
                            return
                except Exception:
                    pass  # Fall through to full check if fast-path fails

            # Get status for ALL data types
            all_status = self.manager.get_all_data_types_status()
            
            # Build comprehensive report
            any_gaps = False
            max_gap = 0
            report_lines = []
            
            self.current_time = datetime.now(timezone.utc)
            report_lines.append("📊 DATA TYPE STATUS:\n")
            
            for data_type, info in all_status.items():
                if info['status'] == 'complete':
                    report_lines.append(f"  ✅ {data_type.upper()}: Complete")
                    if info['start'] and info['end']:
                        report_lines.append(f"     Range: {info['start'].strftime('%Y-%m-%d')} → {info['end'].strftime('%Y-%m-%d')}\n")
                elif info['status'] == 'gap':
                    any_gaps = True
                    max_gap = max(max_gap, info['gap_days'])
                    self.lakeapi_end = info['end']  # Store for download
                    self.gap_days = info['gap_days']
                    report_lines.append(f"  ❌ {data_type.upper()}: GAP DETECTED")
                    if info['start'] and info['end']:
                        report_lines.append(f"     Range: {info['start'].strftime('%Y-%m-%d')} → {info['end'].strftime('%Y-%m-%d %H:%M')}")
                    
                    # Show precise gap for futures trading
                    gap_minutes = info.get('gap_minutes', info['gap_days'] * 1440)
                    if gap_minutes < 60:
                        report_lines.append(f"     Missing: {gap_minutes} minutes ({int(gap_minutes/15)} candles @ 15min)\n")
                    elif gap_minutes < 1440:
                        hours = int(gap_minutes / 60)
                        mins = int(gap_minutes % 60)
                        report_lines.append(f"     Missing: {hours}h {mins}m ({int(gap_minutes/15)} candles @ 15min)\n")
                    else:
                        report_lines.append(f"     Missing: {info['gap_days']} days ({int(gap_minutes/15)} candles @ 15min)\n")
                elif info['status'] == 'missing':
                    any_gaps = True
                    max_gap = 999
                    report_lines.append(f"  ❌ {data_type.upper()}: MISSING")
                    report_lines.append(f"     No data found in data/raw/{data_type}/\n")
                else:
                    report_lines.append(f"  ⚠️  {data_type.upper()}: ERROR")
                    if 'error' in info:
                        report_lines.append(f"     {info['error']}\n")
            
            report_lines.append(f"Current Time: {self.current_time.strftime('%Y-%m-%d %H:%M')}\n")
            
            if any_gaps:
                self.has_gaps = True
                self.status_label.setText(
                    f"⚠️ DATA GAPS DETECTED: Up to {max_gap} days MISSING - Auto-updating..."
                )
                self.status_label.setStyleSheet(get_status_label_style('error'))
                
                report_lines.append("❌ CRITICAL: Building blocks need ALL data types!")
                report_lines.append("   - Trade management needs funding rates")
                report_lines.append("   - Building blocks need liquidations")
                report_lines.append("   - Advanced blocks need orderbook\n")
                report_lines.append("🔄 Auto-updating data now...")
                
                self.details_text.setText("\n".join(report_lines))
                self.update_button.setEnabled(True)
                
                # INSTITUTIONAL FIX: Auto-start update after 1 second (ONLY in auto mode)
                if self.auto_mode:
                    QTimer.singleShot(1000, self._auto_start_update)
            else:
                self.has_gaps = False
                self.status_label.setText("✅ ALL DATA COMPLETE - 100% ACCURATE - Closing in 3s...")
                self.status_label.setStyleSheet(get_status_label_style('success'))
                
                report_lines.append("✅ PERFECT: All data types complete!")
                report_lines.append("   Building blocks have full data access")
                report_lines.append("   Trade Manager ready for deployment\n")
                report_lines.append("Window will close automatically in 3 seconds...")
                
                self.details_text.setText("\n".join(report_lines))
                self.skip_button.setText("Continue")
                
                # INSTITUTIONAL FIX: Auto-close with countdown (ONLY in auto mode)
                if self.auto_mode:
                    self.original_status_text = "✅ ALL DATA COMPLETE - 100% ACCURATE"
                    self._start_countdown()
                else:
                    # Manual mode - just show status without countdown
                    self.status_label.setText("✅ ALL DATA COMPLETE - 100% ACCURATE")
        
        except Exception as e:
            self.status_label.setText("❌ Error checking data")
            self.status_label.setStyleSheet(get_status_label_style('error'))
            
            self.details_text.setText(
                f"Error occurred while checking data:\n\n"
                f"{str(e)}\n\n"
                f"You can skip this check and continue."
            )
    
    def _auto_start_update(self):
        """
        INSTITUTIONAL FIX: Auto-start update if gaps detected
        Called 1 second after modal shows (if gaps exist)
        """
        if self.has_gaps and not self.auto_started:
            self.auto_started = True
            self._start_update()
    
    def _start_update(self):
        """Start the data update process (manual or auto)"""
        if not self.current_time:
            return

        # Disable buttons
        self.update_button.setEnabled(False)
        self.skip_button.setEnabled(False)

        # Show progress
        self.progress_bar.setVisible(True)
        self.progress_bar.setValue(0)
        self.progress_label.setVisible(True)
        self.progress_label.setText("Starting download with retry logic...")

        # STARTUP GAP FIX: Use the last Binance OHLCV bar on disk as the
        # fetch window start so multi-hour gaps from prior sessions are filled.
        # lakeapi_end is the LakeAPI cutoff date (e.g. 2026-03), not the last
        # Binance bar — using it as start_date causes the download to either
        # skip the recent gap or fetch from the wrong anchor.
        # end_date uses datetime.now(timezone.utc) — all bar timestamps are tz-aware UTC after BTCAAAAA-816.
        try:
            last_bar_ts = self.manager.get_last_bar_timestamp('15m')
        except Exception:
            last_bar_ts = None

        end_date = datetime.now(timezone.utc)

        if last_bar_ts is not None:
            start_date = last_bar_ts.replace(tzinfo=timezone.utc)
            logger.info(f"[DataUpdateModal] startup fetch: last_bar_on_disk={last_bar_ts} → "
                        f"fetching to {end_date.strftime('%H:%M:%S')} UTC")
        elif self.lakeapi_end is not None:
            # No Binance bars on disk yet — fall back to LakeAPI end date
            start_date = self.lakeapi_end.replace(tzinfo=timezone.utc) if self.lakeapi_end.tzinfo is None else self.lakeapi_end
            logger.info(f"[DataUpdateModal] no Binance bars on disk; "
                        f"falling back to lakeapi_end={start_date}")
        else:
            # Absolute fallback: fetch last 2 hours
            start_date = end_date - timedelta(hours=2)
            logger.info(f"[DataUpdateModal] no anchor available; "
                        f"fetching last 2h from {start_date.strftime('%H:%M:%S')} UTC")

        # SUB-1D GAP GUARD: The DataUpdateThread downloads 15m, 1h AND 1d bars
        # using the same start_date.  1d bars need a ≥24h window to return at
        # least one closed daily candle.  Without this guard, a sub-24h gap
        # (which is normal for incremental "last bar on disk" updates) causes
        # the 1d download to return 0 bars because today's candle is still
        # forming and no closed daily candle fits in the range.
        gap_seconds = (end_date - start_date).total_seconds()
        if gap_seconds < 86400:
            start_date = end_date - timedelta(hours=24)
            logger.info(f"[DataUpdateModal] sub-1d gap ({gap_seconds:.0f}s) — "
                f"widening query start to {start_date.strftime('%H:%M:%S')} UTC to ensure ≥1 closed daily candle")

        # Create and start update thread (with retry logic!)
        self.update_thread = DataUpdateThread(
            start_date,
            end_date
        )

        # Connect signals
        self.update_thread.progress.connect(self._on_progress)
        self.update_thread.finished.connect(self._on_finished)

        # Start download
        self.update_thread.start()
    
    def _on_progress(self, current: int, total: int, message: str):
        """Handle progress updates"""
        self.progress_bar.setValue(current)
        self.progress_label.setText(message)
    
    def _on_finished(self, success: bool, message: str):
        """
        Handle completion
        
        INSTITUTIONAL FIX: Auto-close 3 seconds after successful update OR auto-retry on failure
        """
        self.progress_bar.setVisible(False)
        self.progress_label.setVisible(False)
        
        if success:
            # Reset retry count on success
            self.retry_count = 0
            
            self.status_label.setText("✅ Update Complete! - Closing in 3s...")
            self.status_label.setStyleSheet(get_status_label_style('success'))
            
            # INSTITUTIONAL FIX: Auto-close with countdown (ONLY in auto mode)
            if self.auto_mode:
                message += "\n\nWindow will close automatically in 3 seconds..."
                self.original_status_text = "✅ Update Complete!"
                self._start_countdown()
            else:
                # Manual mode - show completion without auto-close
                message += "\n\nClick 'Continue' to close."
            
            self.details_text.setText(message)
            
            # Show close button
            self.update_button.setVisible(False)
            self.skip_button.setVisible(False)
            self.close_button.setVisible(True)
        else:
            # FAILURE - check if we should retry
            if self.auto_mode and self.retry_count < self.max_retries:
                # Auto-retry after delay
                self.retry_count += 1
                self.status_label.setText(f"⏳ Update Failed - Auto-retrying in {self.retry_delay}s... (Attempt {self.retry_count + 1}/{self.max_retries + 1})")
                self.status_label.setStyleSheet(get_status_label_style('warning'))
                
                retry_message = (
                    f"{message}\n\n"
                    f"🔄 AUTO-RETRY ENABLED\n"
                    f"Retry attempt {self.retry_count}/{self.max_retries} will start in {self.retry_delay} seconds...\n"
                    f"(Binance API may be temporarily unavailable)"
                )
                self.details_text.setText(retry_message)
                
                # Start retry timer (5 seconds)
                self.retry_timer.start(self.retry_delay * 1000)
            else:
                # No retries left or manual mode - show failure
                if self.retry_count > 0:
                    self.status_label.setText(f"❌ Update Failed After {self.retry_count} Retries")
                else:
                    self.status_label.setText("❌ Update Failed")
                self.status_label.setStyleSheet(get_status_label_style('error'))
                
                self.details_text.setText(message)
                
                # Show close button
                self.update_button.setVisible(False)
                self.skip_button.setVisible(False)
                self.close_button.setVisible(True)
    
    def _retry_update(self):
        """
        INSTITUTIONAL FIX: Retry failed update automatically
        Called by retry_timer after delay (5 seconds)
        """
        self.retry_timer.stop()
        
        # Log retry attempt
        logger.info(f"🔄 AUTO-RETRY: Attempt {self.retry_count}/{self.max_retries} starting now...")
        
        # Restart the update process
        self._start_update()
    
    def _start_countdown(self):
        """Start the countdown timer (3s, 2s, 1s)"""
        self.countdown_seconds = 3
        self._update_countdown()  # Show initial countdown
        self.countdown_timer.start(1000)  # Update every second
    
    def showEvent(self, event):
        """Called when window is shown - apply hand cursors to all widgets"""
        super().showEvent(event)
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))

    
    def _update_countdown(self):
        """Update countdown display and close when reaches 0"""
        if self.countdown_seconds > 0:
            # Update status label with countdown
            self.status_label.setText(
                f"{self.original_status_text} - Closing in {self.countdown_seconds}s..."
            )
            self.countdown_seconds -= 1
        else:
            # Countdown finished - close dialog
            self.countdown_timer.stop()
            self.accept()
