"""
Strategy Browser Dialog
SPRINT 1.6.1 - Phase 2 Day 4-5

Database-backed strategy browser replacing file dialogs.
Provides visual browsing, version management, and quick actions.

Uses institutional-grade DATABASE-FIRST architecture.
"""

from typing import Optional, List, Dict, Any
from datetime import datetime
from PyQt5.QtWidgets import (
    QMainWindow, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem,
    QPushButton, QLabel, QLineEdit, QComboBox, QWidget, QHeaderView,
    QAbstractItemView, QStyledItemDelegate, QStyleOptionViewItem, QGridLayout,
    QFrame, QScrollArea, QSplitter
)
from PyQt5.QtCore import Qt, pyqtSignal, QSettings, QModelIndex, QRectF
from PyQt5.QtGui import QTextDocument, QAbstractTextDocumentLayout, QPalette, QColor

from src.optimizer_v3.database import get_database_manager
from .styles import (
    get_main_stylesheet,
    get_primary_button_stylesheet,
    get_secondary_button_stylesheet,
    get_danger_button_stylesheet,
    get_input_field_stylesheet,
    get_table_stylesheet,
    create_font,
    get_color,
    get_column_title_stylesheet,
    get_exit_icon,
    get_cumulative_exit_color,
    get_recheck_depth_color,
    WindowGeometryMixin,
)
# Import universal combo box fix (EXACTLY like block_search_panel.py)
from src.strategy_builder.ui.combobox_fix import fix_combobox_white_bars
# Import content measurement for smart resizing
from .content_measurement import ContentMeasurement

import logging
logger = logging.getLogger(__name__)

class HTMLDelegate(QStyledItemDelegate):
    """Custom delegate to render HTML in table cells"""
    
    def paint(self, painter, option: QStyleOptionViewItem, index: QModelIndex):
        """Paint HTML content"""
        options = QStyleOptionViewItem(option)
        self.initStyleOption(options, index)
        
        painter.save()
        
        # Create text document for HTML rendering
        doc = QTextDocument()
        doc.setHtml(options.text)
        
        # Set text color from palette
        doc.setDefaultStyleSheet("body { color: #FFFFFF; }")
        
        # Clear text in options (we'll draw it ourselves)
        options.text = ""
        
        # Draw background and borders
        options.widget.style().drawControl(options.widget.style().ControlElement.CE_ItemViewItem, options, painter)
        
        # Check if this item should be centered (based on alignment flag)
        alignment = index.data(Qt.ItemDataRole.TextAlignmentRole)
        
        # Get natural width of content (without width constraint)
        doc.setTextWidth(-1)  # -1 means no width constraint
        natural_width = doc.idealWidth()
        
        # Calculate horizontal offset for centering
        x_offset = 0
        if alignment and (int(alignment) & int(Qt.AlignmentFlag.AlignHCenter)):
            # Center the content horizontally
            x_offset = (options.rect.width() - natural_width) / 2
        
        # Draw HTML text with offset, vertically centered too
        y_offset = (options.rect.height() - doc.size().height()) / 2
        
        painter.translate(options.rect.left() + x_offset, options.rect.top() + y_offset)
        clip = QRectF(0, 0, natural_width, doc.size().height())
        doc.drawContents(painter, clip)
        
        painter.restore()
    
    def sizeHint(self, option: QStyleOptionViewItem, index: QModelIndex):
        """Calculate size hint for HTML content"""
        options = QStyleOptionViewItem(option)
        self.initStyleOption(options, index)
        
        doc = QTextDocument()
        doc.setHtml(options.text)
        doc.setTextWidth(option.rect.width())
        
        return doc.size().toSize()


class StrategyBrowserDialog(WindowGeometryMixin, QMainWindow):

    GEOMETRY_SETTINGS_KEY = "strategyBrowser"
    GEOMETRY_DEFAULT_SIZE = (1200, 800)
    """
    Strategy browser window for database-backed strategy management
    
    Features:
    - Visual table of all strategies with metadata
    - Search and filter capabilities
    - Version information display
    - Quick actions (Open, Delete, Duplicate)
    - Double-click to open
    
    Signals:
        strategy_selected: Emitted when strategy selected (strategy_id, version_id)
        strategy_deleted: Emitted when strategy deleted (strategy_id, was_entire_strategy)
    """
    
    strategy_selected = pyqtSignal(str, str)  # strategy_id, version_id
    strategy_deleted = pyqtSignal(str, bool)  # strategy_id, was_entire_strategy (True) or version (False)
    
    def __init__(self, parent: Optional[QWidget] = None, mode: str = 'open'):
        """
        Initialize strategy browser
        
        Args:
            parent: Parent widget
            mode: Dialog mode ('open' or 'save_as')
        """
        super().__init__(parent)
        self.mode = mode
        self.selected_strategy_id = None
        self.selected_version_id = None
        self.db = None
        
        self._init_ui()
        self._restore_non_geometry_settings()
        self._load_strategies()
    
    def _init_ui(self):
        """Initialize user interface"""
        self.setWindowTitle("Strategy Browser" if self.mode == 'open' else "Save Strategy As")
        # Explicit window flags ensure maximize/minimize buttons are visible on
        # all platforms. QMainWindow with a parent can inherit limiting flags
        # from the parent widget on some Linux window managers.
        self.setWindowFlags(
            Qt.Window |
            Qt.WindowMaximizeButtonHint |
            Qt.WindowMinimizeButtonHint |
            Qt.WindowCloseButtonHint
        )
        self.setMinimumSize(900, 600)
        self.setStyleSheet(get_main_stylesheet())
        
        # Create central widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        layout = QVBoxLayout(central_widget)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 24, 24, 24)
        
        # Header
        header_layout = QHBoxLayout()
        
        title_label = QLabel("📚 Strategy Browser" if self.mode == 'open' else "💾 Save Strategy As")
        title_label.setFont(create_font(16, bold=True))
        title_label.setStyleSheet(f"color: {get_color('panel_title')}; font-size: 16pt; font-weight: bold;")
        header_layout.addWidget(title_label)
        
        header_layout.addStretch()
        
        # Search box
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("Search strategies...")
        self.search_input.setStyleSheet(get_input_field_stylesheet())
        self.search_input.setMinimumWidth(250)
        self.search_input.setToolTip("Filter strategies by name — updates results as you type")
        self.search_input.textChanged.connect(self._on_search_changed)
        header_layout.addWidget(self.search_input)
        
        layout.addLayout(header_layout)
  
        # Filter row
        filter_layout = QHBoxLayout()
        
        filter_label = QLabel("Strategy Type:")
        filter_label.setFont(create_font(10))
        filter_label.setStyleSheet(f"color: {get_color('text_secondary')};")
        filter_layout.addWidget(filter_label)
        
        self.type_filter = QComboBox()
        self.type_filter.addItems(["All", "Bullish", "Bearish"])
        self.type_filter.setToolTip("Filter strategies by market direction — Bullish (long) or Bearish (short)")
        fix_combobox_white_bars(self.type_filter)
        self.type_filter.currentTextChanged.connect(self._apply_filters)
        filter_layout.addWidget(self.type_filter)
        
        filter_layout.addStretch()
        
        # Strategy count
        self.count_label = QLabel("0 strategies")
        self.count_label.setFont(create_font(9))
        self.count_label.setStyleSheet(f"color: {get_color('text_tertiary')};")
        filter_layout.addWidget(self.count_label)
        
        layout.addLayout(filter_layout)
        
        # Table
        self.table = QTableWidget()
        self.table.setColumnCount(6)
        self.table.setHorizontalHeaderLabels([
            "Strategy Name", "Type", "Version", "Last Modified", "Validation", "Published"
        ])
        self.table.setStyleSheet(get_table_stylesheet())
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        
        # Column widths - Make columns 2x wider minimum
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)  # Name (flexible)
        header.setMinimumSectionSize(120)  # Minimum width for all columns
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Interactive)  # Type
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Interactive)  # Version
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Interactive)  # Modified
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.Interactive)  # Tests
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Interactive)  # Performance
        
        # Set initial widths (2x wider than before)
        header.resizeSection(1, 240)  # Type
        header.resizeSection(2, 240)  # Version
        header.resizeSection(3, 400)  # Last Modified
        header.resizeSection(4, 180)  # Validation (fits "Un-Validated")
        header.resizeSection(5, 160)  # Published (fits "Published")
        
        # Enable sorting (clickable headers with sort indicators)
        self.table.setSortingEnabled(True)
        
        # Set HTML delegate for name and type columns to render rich text
        self.table.setItemDelegateForColumn(0, HTMLDelegate(self.table))
        self.table.setItemDelegateForColumn(1, HTMLDelegate(self.table))  # Type column needs HTML for colored emojis
        
        self.table.itemSelectionChanged.connect(self._on_selection_changed)
        self.table.itemDoubleClicked.connect(self._on_double_click)
        
        # Strategy Details Panel (resizable via splitter, 3-column grid, institutional-grade)
        self.details_frame = QFrame()
        self.details_frame.setMinimumHeight(450)  # Minimum height (user requirement)
        self.details_frame.setMaximumHeight(16777215)  # Will be constrained by splitter
        # Match GroupBox styling from styles.py (#1E2128 background)
        self.details_frame.setStyleSheet(f"""
            QFrame {{
                background-color: {get_color('bg_medium')};
                border: 1px solid {get_color('border')};
                border-radius: 8px;
            }}
        """)
        self.details_frame.setVisible(False)  # Hidden until selection
        
        details_layout = QGridLayout(self.details_frame)
        details_layout.setSpacing(20)
        details_layout.setContentsMargins(20, 16, 20, 16)
        
        # Create labels with proper styling FROM STYLES.PY ONLY
        self.detail_labels = {}
        
        # Column 1: Strategy Info
        col1_title = QLabel("📊 STRATEGY INFORMATION")
        col1_title.setFont(create_font(10, bold=True))
        col1_title.setStyleSheet(get_column_title_stylesheet())
        details_layout.addWidget(col1_title, 0, 0)
        
        self.detail_labels['name'] = QLabel("Select a strategy to view details")
        self.detail_labels['name'].setFont(create_font(10))
        self.detail_labels['name'].setStyleSheet(f"color: {get_color('text_primary')}; padding: 4px 6px;")
        self.detail_labels['name'].setWordWrap(True)
        self.detail_labels['name'].setTextFormat(Qt.TextFormat.RichText)  # Enable HTML rendering
        details_layout.addWidget(self.detail_labels['name'], 1, 0, 1, 1)
        
        self.detail_labels['description'] = QLabel("Description will appear here")
        self.detail_labels['description'].setFont(create_font(9))
        self.detail_labels['description'].setStyleSheet(f"color: {get_color('text_secondary')}; padding: 4px 6px;")
        self.detail_labels['description'].setWordWrap(True)
        self.detail_labels['description'].setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        details_layout.addWidget(self.detail_labels['description'], 2, 0, 1, 1)
        
        self.detail_labels['meta'] = QLabel("No metadata")
        self.detail_labels['meta'].setFont(create_font(9))
        self.detail_labels['meta'].setStyleSheet(f"color: {get_color('text_muted')}; padding: 4px 6px;")
        details_layout.addWidget(self.detail_labels['meta'], 3, 0, 1, 1)
        
        # Column 2: Configuration
        col2_title = QLabel("⚙️ CONFIGURATION")
        col2_title.setFont(create_font(10, bold=True))
        col2_title.setStyleSheet(get_column_title_stylesheet())
        details_layout.addWidget(col2_title, 0, 1)
        
        # Configuration signals - wrap in scroll area for overflow
        blocks_scroll = QScrollArea()
        blocks_scroll.setWidgetResizable(True)
        blocks_scroll.setFrameShape(QFrame.Shape.NoFrame)
        blocks_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        blocks_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        blocks_scroll.setStyleSheet(f"background-color: transparent; border: none;")
        
        self.detail_labels['blocks'] = QLabel("No blocks configured")
        self.detail_labels['blocks'].setFont(create_font(9))
        self.detail_labels['blocks'].setStyleSheet(f"color: {get_color('text_secondary')}; padding: 4px 6px;")
        self.detail_labels['blocks'].setWordWrap(True)
        self.detail_labels['blocks'].setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        
        blocks_scroll.setWidget(self.detail_labels['blocks'])
        details_layout.addWidget(blocks_scroll, 1, 1, 2, 1)
        
        self.detail_labels['signals'] = QLabel("No signals configured")
        self.detail_labels['signals'].setFont(create_font(9))
        self.detail_labels['signals'].setStyleSheet(f"color: {get_color('text_muted')}; padding: 4px 6px;")
        self.detail_labels['signals'].setWordWrap(True)
        details_layout.addWidget(self.detail_labels['signals'], 3, 1, 1, 1)
        
        # Column 3: Performance & Metrics
        col3_title = QLabel("📈 PERFORMANCE")
        col3_title.setFont(create_font(10, bold=True))
        col3_title.setStyleSheet(get_column_title_stylesheet())
        details_layout.addWidget(col3_title, 0, 2)
        
        self.detail_labels['tests'] = QLabel("No tests run")
        self.detail_labels['tests'].setFont(create_font(9))
        self.detail_labels['tests'].setStyleSheet(f"color: {get_color('text_muted')}; padding: 4px 6px;")
        details_layout.addWidget(self.detail_labels['tests'], 1, 2, 1, 1)
        
        self.detail_labels['performance'] = QLabel("Run backtest to see metrics")
        self.detail_labels['performance'].setStyleSheet(f"color: {get_color('text_secondary')}; padding: 4px 6px;")
        self.detail_labels['performance'].setWordWrap(True)
        self.detail_labels['performance'].setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        details_layout.addWidget(self.detail_labels['performance'], 2, 2, 1, 1)
        
        self.detail_labels['status'] = QLabel("Status: Unknown")
        self.detail_labels['status'].setFont(create_font(9))
        self.detail_labels['status'].setStyleSheet(f"color: {get_color('text_muted')}; padding: 4px 6px;")
        details_layout.addWidget(self.detail_labels['status'], 3, 2, 1, 1)
        
        # Set column stretches to match screenshot 1 proportions
        # Strategy Info: Compact (~30%)
        # Configuration: LARGER (~45%) - needs space for signal hierarchy
        # Performance: Compact (~25%)
        # Ratio 2:3:2 gives Configuration 43% of space (3/7)
        details_layout.setColumnStretch(0, 2)  # Strategy Info - Compact
        details_layout.setColumnStretch(1, 3)  # Configuration - LARGER (1.5x others)
        details_layout.setColumnStretch(2, 2)  # Performance - Compact
        
        # Set row stretches to match screenshot 1
        # Row 0: Titles (no stretch)
        # Row 1: Compact - name/tests (minimal height)
        # Row 2: LARGE - description/blocks/performance (MOST space)
        # Row 3: Compact - meta/signals/status (minimal height)
        details_layout.setRowStretch(1, 0)  # Row 1: COMPACT (no stretch)
        details_layout.setRowStretch(2, 1)  # Row 2: LARGE (gets all extra space)
        details_layout.setRowStretch(3, 0)  # Row 3: COMPACT (no stretch)
        
        # Create vertical splitter for table + details (resizable like main window)
        content_splitter = QSplitter(Qt.Orientation.Vertical)
        content_splitter.addWidget(self.table)
        content_splitter.addWidget(self.details_frame)
        
        # Set initial sizes (60% table, 40% details) - total window ~800px
        content_splitter.setSizes([480, 320])
        
        # CRITICAL: Prevent panel from being collapsed/disappearing
        # Index 0 = table (min 200px), Index 1 = details (min 450px)
        content_splitter.setCollapsible(0, False)  # Table cannot collapse
        content_splitter.setCollapsible(1, False)  # Details cannot collapse
        content_splitter.setStretchFactor(0, 1)  # Table gets priority for extra space
        content_splitter.setStretchFactor(1, 0)  # Details stays at set size
        
        # Add visual drag indicator to splitter handle
        content_splitter.setHandleWidth(8)  # Wider handle for better visibility
        content_splitter.setStyleSheet(f"""
            QSplitter::handle:vertical {{
                background-color: {get_color('border')};
                height: 8px;
                margin: 0px;
                padding: 0px;
                image: url(none);
            }}
            QSplitter::handle:vertical:hover {{
                background-color: {get_color('panel_title')};
            }}
        """)
        
        # Add drag indicator icon to handle
        handle = content_splitter.handle(1)
        if handle:
            handle_layout = QHBoxLayout(handle)
            handle_layout.setContentsMargins(0, 0, 0, 0)
            handle_layout.setSpacing(0)
            
            # Add centered drag icon (⋮⋮⋮) - muted color
            drag_icon = QLabel("⋮⋮⋮")
            drag_icon.setFont(create_font(10, bold=True))
            drag_icon.setStyleSheet("color: #4A4F58; background: transparent;")  # Muted gray
            drag_icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
            handle_layout.addWidget(drag_icon)
        
        # Store splitter for settings save/restore
        self.content_splitter = content_splitter
        
        layout.addWidget(content_splitter)
        
        # Action buttons
        button_layout = QHBoxLayout()
        
        # Left side actions
        if self.mode == 'open':
            self.delete_btn = QPushButton("🗑️ Delete")
            self.delete_btn.setStyleSheet(get_danger_button_stylesheet())
            self.delete_btn.setEnabled(False)
            self.delete_btn.setToolTip("Permanently delete the selected strategy and all its versions from the database")
            self.delete_btn.clicked.connect(self._on_delete)
            button_layout.addWidget(self.delete_btn)
            
            self.duplicate_btn = QPushButton("📋 Duplicate")
            self.duplicate_btn.setStyleSheet(get_secondary_button_stylesheet())
            self.duplicate_btn.setEnabled(False)
            self.duplicate_btn.setToolTip("Create a copy of the selected strategy as a new entry")
            self.duplicate_btn.clicked.connect(self._on_duplicate)
            button_layout.addWidget(self.duplicate_btn)
            
            self.export_btn = QPushButton("📥 Export to JSON")
            self.export_btn.setStyleSheet(get_secondary_button_stylesheet())
            self.export_btn.setEnabled(False)
            self.export_btn.setToolTip("Export the selected strategy's configuration to a JSON file")
            self.export_btn.clicked.connect(self._on_export)
            button_layout.addWidget(self.export_btn)
            
            self.import_btn = QPushButton("📤 Import from JSON")
            self.import_btn.setStyleSheet(get_secondary_button_stylesheet())
            self.import_btn.setToolTip("Import a strategy configuration from a previously exported JSON file")
            self.import_btn.clicked.connect(self._on_import)
            button_layout.addWidget(self.import_btn)
        
        button_layout.addStretch()
        
        # Right side actions
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setStyleSheet(get_secondary_button_stylesheet())
        self.cancel_btn.setToolTip("Close the browser without opening or saving a strategy")
        self.cancel_btn.clicked.connect(self.reject)
        button_layout.addWidget(self.cancel_btn)
        
        self.open_btn = QPushButton("Open" if self.mode == 'open' else "Save Here")
        self.open_btn.setStyleSheet(get_primary_button_stylesheet())
        self.open_btn.setEnabled(False)
        self.open_btn.setToolTip("Open the selected strategy in the Strategy Builder" if self.mode == 'open' else "Save the current strategy to the selected entry")
        self.open_btn.clicked.connect(self.accept)
        button_layout.addWidget(self.open_btn)
        
        layout.addLayout(button_layout)
    
    def _load_strategies(self):
        """Load strategies from database"""
        try:
            self.db = get_database_manager()
            
            # CRITICAL: Clear any previous failed transaction state
            self.db.strategy.session.rollback()

            # Get all strategies with latest version info
            strategies = self.db.strategy.get_all_strategies()

            self.all_strategies = []

            for strategy in strategies:
                try:
                    # Get latest version details
                    latest = self.db.strategy.get_latest_version(strategy['strategy_id'])

                    if latest:
                        # Get test results count (handle missing table gracefully)
                        try:
                            tests = self.db.test_results.get_version_test_results(latest['version_id'])
                            test_count = len(tests)
                        except Exception:
                            # Table doesn't exist yet or schema mismatch - no tests run yet
                            tests = []
                            test_count = 0

                        # Get best test result
                        best_perf = "N/A"
                        if tests:
                            best_test = max(tests, key=lambda t: t.get('sharpe_ratio', 0) or 0)
                            sharpe = best_test.get('sharpe_ratio')
                            if sharpe:
                                best_perf = f"Sharpe: {sharpe:.2f}"

                        # Extract strategy_type and blocks summary
                        strategy_type = "Unknown"
                        blocks_summary = ""
                        blocks_data = latest.get('blocks', [])
                        
                        if blocks_data and len(blocks_data) > 0:
                            # Build blocks summary: block_name [signals]
                            block_parts = []
                            for block in blocks_data[:3]:  # Limit to first 3 blocks
                                block_name = block.get('name', 'unknown')
                                signals = block.get('signals', [])
                                
                                # Get key signal names
                                signal_names = []
                                for signal in signals[:2]:  # Max 2 signals per block
                                    sig_name = signal.get('name', '') if isinstance(signal, dict) else str(signal)
                                    if sig_name:
                                        # Clean up signal name (remove common prefixes)
                                        clean_name = sig_name.replace('_', ' ').title()
                                        signal_names.append(clean_name)
                                
                                if signal_names:
                                    block_parts.append(f"{block_name} [{', '.join(signal_names)}]")
                                else:
                                    block_parts.append(block_name)
                            
                            if block_parts:
                                blocks_summary = " | ".join(block_parts)
                                if len(blocks_data) > 3:
                                    blocks_summary += f" + {len(blocks_data) - 3} more"
                        
                        # Read strategy_type directly from database
                        strategy_type = latest.get('strategy_type', 'Unknown')
                        
                        # Build enriched display name with HTML color coding
                        display_name = latest['name']
                        if blocks_summary:
                            # Color-coded format for readability
                            # Strategy name: light grey (#CCCCCC) - readable on dark background
                            # Block names: cyan (#00BCD4)
                            # Signals: light green (#81C784)
                            # Separators: dim gray (#666666)
                            
                            # Parse blocks_summary and add colors
                            colored_blocks = []
                            for block_part in blocks_summary.split(' | '):
                                if '[' in block_part and ']' in block_part:
                                    # Has signals
                                    block_name, signals_part = block_part.split(' [', 1)
                                    signals = signals_part.rstrip(']')
                                    colored_blocks.append(
                                        f'<span style="color: #00BCD4;">{block_name}</span> '
                                        f'<span style="color: #666666;">[</span>'
                                        f'<span style="color: #81C784;">{signals}</span>'
                                        f'<span style="color: #666666;">]</span>'
                                    )
                                else:
                                    # No signals, just block name
                                    colored_blocks.append(f'<span style="color: #00BCD4;">{block_part}</span>')
                            
                            colored_summary = ' <span style="color: #666666;">|</span> '.join(colored_blocks)
                            display_name = f'<span style="color: #CCCCCC;">{latest["name"]}</span> <span style="color: #666666;">-</span> {colored_summary}'
                        
                        self.all_strategies.append({
                            'strategy_id': strategy['strategy_id'],
                            'version_id': latest['version_id'],
                            'name': latest['name'],
                            'display_name': display_name,  # Enriched name with blocks
                            'description': latest.get('description', ''),
                            'version_number': latest['version_number'],
                            'created_at': latest['created_at'],
                            'test_count': test_count,
                            'performance': best_perf,
                            'tags': latest.get('tags', []),
                            'strategy_type': strategy_type
                        })
                    
                except Exception as e:
                    # Skip strategies that fail to load (data corruption or missing versions)
                    # Rollback to clear failed state and continue with next strategy
                    self.db.strategy.session.rollback()
                    logger.warning(f"⚠️ Skipping strategy {strategy.get('strategy_id', 'unknown')}: {e}")
                    continue

            self._populate_table(self.all_strategies)

        except Exception as e:
            logger.error(f"❌ Error loading strategies: {e}")
            self.all_strategies = []
    
    def _populate_table(self, strategies: List[Dict[str, Any]]):
        """Populate table with strategies"""
        self.table.setRowCount(0)
        
        for strategy in strategies:
            row = self.table.rowCount()
            self.table.insertRow(row)
            
            # Name - Use enriched display name with blocks (HTML formatted)
            display_name = strategy.get('display_name', strategy['name'])
            name_item = QTableWidgetItem()
            name_item.setData(Qt.ItemDataRole.DisplayRole, display_name) 
            name_item.setData(Qt.ItemDataRole.UserRole, strategy)
            # Enable HTML/rich text rendering
            name_item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, 0, name_item)
            
            # Type - Show Bullish/Bearish from stored strategy_type with colored indicator (centered)
            strategy_type = strategy.get('strategy_type', 'Unknown')
            # Use HTML with colored bullets and gray text (NO div wrapper - use Qt alignment instead)
            if strategy_type == 'Bullish':
                type_display = '<span style="color: #7cc27a;">●</span> <span style="color: #9CA3AF;">Bullish&nbsp;&nbsp;</span>'
            elif strategy_type == 'Bearish':
                type_display = '<span style="color: #c35252;">●</span> <span style="color: #9CA3AF;">Bearish</span>'
            else:
                type_display = f'<span style="color: #9CA3AF;">{strategy_type}</span>'
            
            type_item = QTableWidgetItem(type_display)
            # Use Qt native alignment (like Validation and Published columns)
            type_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 1, type_item)
            
            # Version - Create dropdown with all versions
            version_combo = QComboBox()
            
            # Get all versions for this strategy
            all_versions = self.db.strategy.get_strategy_versions(strategy['strategy_id'])
            
            current_version_index = 0
            for i, ver in enumerate(all_versions):
                version_label = f"v{ver['version_number']}"
                version_combo.addItem(version_label, ver['version_id'])
                
                # Mark current version
                if ver['version_id'] == strategy['version_id']:
                    current_version_index = i
            
            # CRITICAL: Apply fix AFTER items added (same as filter dropdowns)
            fix_combobox_white_bars(version_combo)
            
            version_combo.setCurrentIndex(current_version_index)
            version_combo.currentIndexChanged.connect(
                lambda idx, r=row: self._on_table_version_changed(r, idx)
            )
            
            self.table.setCellWidget(row, 2, version_combo)
            
            # Last Modified (centered)
            created_at = strategy['created_at']
            if isinstance(created_at, datetime):
                time_str = created_at.strftime("%Y-%m-%d %H:%M")
            else:
                time_str = str(created_at)[:16]
            modified_item = QTableWidgetItem(time_str)
            modified_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 3, modified_item)
            
            # Validation status (centered) - Sprint 1.9 ORM persistence
            # Get actual validation status from database version
            version_data = self.db.strategy.get_strategy_version(strategy['version_id'])
            validation_status = version_data.get('validation_status', 'Un-Validated') if version_data else 'Un-Validated'
            
            validation_item = QTableWidgetItem(validation_status)
            validation_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            # Color coding: Un-Validated (gray), Pass (green), Fail (red)
            if validation_status == 'Pass':
                validation_item.setForeground(QColor('#4ADE80'))  # Green
            elif validation_status == 'Fail':
                validation_item.setForeground(QColor('#EF4444'))  # Red
            else:  # Un-Validated
                validation_item.setForeground(QColor('#9CA3AF'))  # Gray
            self.table.setItem(row, 4, validation_item)
            
            # Published status (centered)
            # TODO: Get actual published status from database
            # For now, all strategies are "Draft" (Published feature not yet developed)
            published_status = strategy.get('published_status', 'Draft')
            published_item = QTableWidgetItem(published_status)
            published_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.table.setItem(row, 5, published_item)
        
        self._update_count_label(len(strategies))
    
    def _on_search_changed(self, text: str):
        """Handle search text change"""
        self._apply_filters()
    
    def _apply_filters(self):
        """Apply search and filters with multi-field search"""
        search_text = self.search_input.text().lower()
        type_filter = self.type_filter.currentText()
        
        filtered = []
        
        for strategy in self.all_strategies:
            # Multi-field search: name, description, type, date
            if search_text:
                # Search in name
                name_match = search_text in strategy['name'].lower()
                
                # Search in description
                desc_match = search_text in strategy.get('description', '').lower()
                
                # Search in strategy type (bullish/bearish)
                type_text = strategy.get('strategy_type', 'Unknown').lower()
                type_match = search_text in type_text
                
                # Search in date
                created_at = strategy['created_at']
                if isinstance(created_at, datetime):
                    date_str = created_at.strftime("%Y-%m-%d").lower()
                else:
                    date_str = str(created_at).lower()
                date_match = search_text in date_str
                
                # Search in blocks (if blocks data available)
                blocks_match = False
                # TODO: Could search in blocks data when we have access to it
                
                # If no match in any field, skip
                if not (name_match or desc_match or type_match or date_match or blocks_match):
                    continue
            
            # Apply type filter (Bullish/Bearish)
            if type_filter != "All":
                if type_filter != strategy.get('strategy_type', 'Unknown'):
                    continue
            
            filtered.append(strategy)
        
        self._populate_table(filtered)
    
    def _update_count_label(self, count: int):
        """Update strategy count label"""
        self.count_label.setText(f"{count} strateg{'y' if count == 1 else 'ies'}")
    
    def _calculate_cumulative_exits_for_signal(
        self, signal: Dict, block: Dict, all_blocks: List[Dict]
    ) -> float:
        """
        Calculate cumulative exit percentage across all binding levels for a signal.
        Sprint 1.9.1 Task 1.9.1.5
        
        Args:
            signal: Signal dictionary
            block: Block containing this signal
            all_blocks: All blocks in strategy (to check strategy-level exits)
        
        Returns:
            Total exit percentage (0-1000+)
        """
        total_percentage = 0.0
        signal_name = signal.get('name', '')
        
        # 1. Signal-level exits (attached to this signal)
        signal_exits = signal.get('exit_conditions', [])
        for exit_cond in signal_exits:
            percentage = exit_cond.get('percentage', 0) * 100  # Convert to percentage
            total_percentage += percentage
        
        # 2. Block-level exits (attached to parent block)
        block_exits = block.get('exit_conditions', [])
        for exit_cond in block_exits:
            # Block exits apply to all signals in block
            percentage = exit_cond.get('percentage', 0) * 100
            total_percentage += percentage
        
        # 3. Strategy-level exits (need to check version data if available)
        # NOTE: Strategy-level exits are typically stored at version level, not in blocks
        # For now, we'll check if blocks have strategy_exit_conditions metadata
        # This is a limitation of the current data structure
        
        return total_percentage
    
    def _build_signal_hierarchy_html(self, blocks: List[Dict], strategy_exits: List[Dict] = None) -> str:
        """
        Build hierarchical signal display HTML matching Window 1 format
        
        Args:
            blocks: List of block dictionaries from database
            strategy_exits: Strategy-level exit conditions (apply to ALL signals)
            
        Returns:
            HTML string with hierarchical signal display
        """
        if not blocks:
            return "No signals configured"
        
        # Default to empty list if not provided
        if strategy_exits is None:
            strategy_exits = []
        
        html_lines = []
        # No header - start directly with signals to maximize space
        
        signal_counter = 1
        for block in blocks:
            signals = block.get('signals', [])
            if not signals:
                continue
            
            block_name = block.get('name', 'unknown')
            
            for signal in signals:
                signal_name = signal.get('name', 'Unknown')
                signal_logic = signal.get('logic', 'AND')
                building_block = signal.get('building_block', None)  # NEW: Get building block name
                
                # NEW: Add building block name if available
                block_name_display = f" ({building_block})" if building_block else ""
                
                # Signal line with AND/OR badge and building block name (NO exit badge on signals)
                logic_color = "#4ADE80" if signal_logic == "AND" else "#60A5FA"
                signal_line = f'<span style="color: {logic_color};">{signal_counter}. {signal_name}{block_name_display} [{signal_logic}]</span>'
                html_lines.append(signal_line)
                
                # TIME CONSTRAINT (if exists)
                if signal.get('timing_constraint'):
                    timing = signal['timing_constraint']
                    ref_signal = timing.get('reference_signal', 'previous signal')
                    max_candles = timing.get('max_candles', 'N/A')
                    time_line = f'<span style="color: #FFA500;">&nbsp;&nbsp;&nbsp;&nbsp;└── TIME CONSTRAINT</span>'
                    html_lines.append(time_line)
                    time_detail = f'<span style="color: #FFA500;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── Within {max_candles} candles of {ref_signal}</span>'
                    html_lines.append(time_detail)
                
                # RECHECK (if exists)
                if signal.get('recheck_config'):
                    recheck_cfg = signal['recheck_config']
                    if recheck_cfg.get('enabled'):
                        bar_delay = recheck_cfg.get('bar_delay', 0)
                        recheck_mode = recheck_cfg.get('mode', 'WITHIN')
                        recheck_line = f'<span style="color: #4ADE80;">&nbsp;&nbsp;&nbsp;&nbsp;└── RECHECK ({recheck_mode} {bar_delay} bars)</span>'
                        html_lines.append(recheck_line)

                        # Nested RECHECKs (if exist)
                        if signal.get('recheck_chain'):
                            for nested in signal['recheck_chain']:
                                if nested.get('enabled'):
                                    nested_delay = nested.get('bar_delay', 0)
                                    nested_mode = nested.get('mode', 'WITHIN')
                                    validation_mode = nested.get('validation_mode', 'SIGNAL')
                                    target = "of RECHECK" if validation_mode == "RECHECK" else "of Signal"
                                    nested_line = f'<span style="color: #60A5FA;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── RECHECK {target} ({nested_mode} {nested_delay} bars)</span>'
                                    html_lines.append(nested_line)
                
                # SIGNAL-LEVEL EXIT CONDITIONS ONLY (shown under each signal)
                # Block and strategy exits shown later to avoid duplication
                exit_icon = get_exit_icon()
                signal_exits = signal.get('exit_conditions', [])
                
                if signal_exits:
                    for exit_cond in signal_exits:
                        exit_signal_name = exit_cond.get('signal_name', 'Unknown')
                        exit_percentage = exit_cond.get('percentage', 0) * 100
                        exit_mode = exit_cond.get('exit_mode', 'ABSOLUTE')
                        
                        # PROJECT-SPECIFIC: Based on Sprint 1.8 semantics
                        # ABSOLUTE = Exits immediately when signal fires (no TP consideration)
                        # FLEXIBLE = Defers exit if heading toward TP, fires on reversal
                        if exit_mode == 'ABSOLUTE':
                            mode_label = f"{exit_percentage:.0f}% immediate exit"
                        else:  # FLEXIBLE
                            mode_label = f"{exit_percentage:.0f}% TP-aware exit"
                        
                        # Signal-level exits in RED with execution behavior label
                        color = '#FF6B6B'
                        exit_line = f'<span style="color: {color};">&nbsp;&nbsp;&nbsp;&nbsp;└── {exit_icon} EXIT: {exit_signal_name} - {mode_label} [🟡 SIGNAL]</span>'
                        html_lines.append(exit_line)
                        
                        # EXIT RECHECK (if exists on this exit condition)
                        if exit_cond.get('recheck_config'):
                            exit_recheck = exit_cond['recheck_config']
                            if exit_recheck.get('enabled'):
                                exit_bar_delay = exit_recheck.get('bar_delay', 0)
                                exit_recheck_mode = exit_recheck.get('mode', 'WITHIN')
                                exit_recheck_line = f'<span style="color: #4ADE80;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── RECHECK ({exit_recheck_mode} {exit_bar_delay} bars)</span>'
                                html_lines.append(exit_recheck_line)
                
                signal_counter += 1
            
            # BLOCK-LEVEL EXIT CONDITIONS (shown ONCE at end of block)
            # Apply to ALL signals in this block
            block_exits = block.get('exit_conditions', [])
            if block_exits:
                html_lines.append(f'<br><span style="color: #81C784;"><b>Block-Level Exit Conditions:</b> ({block_name})</span>')
                for exit_cond in block_exits:
                    exit_signal_name = exit_cond.get('signal_name', 'Unknown')
                    exit_percentage = exit_cond.get('percentage', 0) * 100
                    exit_mode = exit_cond.get('exit_mode', 'ABSOLUTE')
                    
                    # PROJECT-SPECIFIC: Based on Sprint 1.8 semantics
                    # ABSOLUTE = Exits immediately when signal fires (no TP consideration)
                    # FLEXIBLE = Defers exit if heading toward TP, fires on reversal
                    if exit_mode == 'ABSOLUTE':
                        mode_label = f"{exit_percentage:.0f}% immediate exit"
                    else:  # FLEXIBLE
                        mode_label = f"{exit_percentage:.0f}% TP-aware exit"
                    
                    color = '#FF6B6B'
                    exit_line = f'<span style="color: {color};">&nbsp;&nbsp;└── {exit_icon} EXIT: {exit_signal_name} - {mode_label} [🟩 BLOCK]</span>'
                    html_lines.append(exit_line)
        
        # STRATEGY-LEVEL EXIT CONDITIONS (shown ONCE at very end)
        # Apply to ALL signals in entire strategy
        if strategy_exits:
            html_lines.append(f'<br><span style="color: #00BCD4;"><b>Strategy Exit Conditions:</b> (Apply to all signals)</span>')
            for exit_cond in strategy_exits:
                exit_signal_name = exit_cond.get('signal_name', 'Unknown')
                exit_percentage = exit_cond.get('percentage', 0) * 100
                exit_mode = exit_cond.get('exit_mode', 'ABSOLUTE')
                
                # PROJECT-SPECIFIC: Based on Sprint 1.8 semantics
                # ABSOLUTE = Exits immediately when signal fires (no TP consideration)
                # FLEXIBLE = Defers exit if heading toward TP, fires on reversal
                if exit_mode == 'ABSOLUTE':
                    mode_label = f"{exit_percentage:.0f}% immediate exit"
                else:  # FLEXIBLE
                    mode_label = f"{exit_percentage:.0f}% TP-aware exit"
                
                color = '#FF6B6B'
                exit_line = f'<span style="color: {color};">&nbsp;&nbsp;└── {exit_icon} EXIT: {exit_signal_name} - {mode_label} [🔷 STRATEGY]</span>'
                html_lines.append(exit_line)
        
        return "<br>".join(html_lines)
    
    def _populate_details_panel(self, version_id: str):
        """Populate details panel with strategy information from database"""
        try:
            # Get full version data from database
            version = self.db.strategy.get_strategy_version(version_id)
            if not version:
                return
            
            # Read strategy type directly from database
            strategy_type = version.get('strategy_type', 'Unknown')
            
            # Column 1: Strategy Info  
            # Use HTML with colored bullets (2x font-size for icon, nudged down to align with text)
            if strategy_type == 'Bullish':
                type_badge = f'<span style="color: #7cc27a; font-size: 17pt;">●</span> {strategy_type}'
            elif strategy_type == 'Bearish':
                type_badge = f'<span style="color: #c35252; font-size: 17pt;">●</span> {strategy_type}'
            else:
                type_badge = strategy_type
            self.detail_labels['name'].setText(f"{version['name']} ({type_badge})")
            
            desc = version.get('description', 'No description')
            self.detail_labels['description'].setText(desc if desc else 'No description')
            
            created = version['created_at']
            if isinstance(created, datetime):
                date_str = created.strftime("%Y-%m-%d %H:%M")
            else:
                date_str = str(created)[:16]
            
            # Only show tags if they exist
            tags = version.get('tags', [])
            if tags:
                tags_str = ', '.join(tags)
                meta_text = f"<b>Version:</b> v{version['version_number']}<br><b>Created:</b> {date_str}<br><b>Tags:</b> {tags_str}"
            else:
                meta_text = f"<b>Version:</b> v{version['version_number']}<br><b>Created:</b> {date_str}"
            self.detail_labels['meta'].setText(meta_text)
            
            # Column 2: Configuration
            blocks = version.get('blocks', [])
            block_count = len(blocks)
            
            # Count actual signals and exit conditions (Sprint 1.8 - exits are now exit_conditions, not position='exit')
            total_entry_signals = 0
            total_exit_conditions = 0
            
            # Count entry signals (all signals are entries unless marked otherwise)
            for block in blocks:
                signals = block.get('signals', [])
                for signal in signals:
                    if isinstance(signal, dict):
                        # All signals count as entries (Sprint 1.8 removed position field)
                        total_entry_signals += 1
            
            # Count exit conditions at all 3 binding levels (Sprint 1.8 architecture)
            # 1. Strategy-level exits
            strategy_exits = version.get('exit_conditions', [])
            total_exit_conditions += len(strategy_exits)
            
            # 2. Block-level exits
            for block in blocks:
                block_exits = block.get('exit_conditions', [])
                total_exit_conditions += len(block_exits)
            
            # 3. Signal-level exits
            for block in blocks:
                signals = block.get('signals', [])
                for signal in signals:
                    if isinstance(signal, dict):
                        signal_exits = signal.get('exit_conditions', [])
                        total_exit_conditions += len(signal_exits)
            
            # Use hierarchical signal display (matching Window 1 format)
            # BUG FIX: Pass strategy-level exits so they display in tree
            signal_hierarchy_html = self._build_signal_hierarchy_html(blocks, strategy_exits)
            self.detail_labels['blocks'].setText(signal_hierarchy_html)
            
            # Signals summary with actual counts (Sprint 1.8 - exits are exit_conditions now)
            sig_text = f"<b>Entry:</b> {total_entry_signals} signal{'s' if total_entry_signals != 1 else ''}<br>"
            sig_text += f"<b>Exit:</b> {total_exit_conditions} condition{'s' if total_exit_conditions != 1 else ''}"
            self.detail_labels['signals'].setText(sig_text)
            
            # Column 3: Performance & Metrics
            try:
                tests = self.db.test_results.get_version_test_results(version_id)
                test_count = len(tests)
                
                if tests:
                    # Get best test by Sharpe
                    best = max(tests, key=lambda t: t.get('sharpe_ratio', 0) or 0)
                    sharpe = best.get('sharpe_ratio', 0)
                    win_rate = best.get('win_rate', 0)
                    total_trades = best.get('total_trades', 0)
                    
                    # Calculate wins and losses
                    wins = int(total_trades * win_rate / 100) if total_trades > 0 else 0
                    losses = total_trades - wins
                    
                    # Show trade breakdown (kept for backward compatibility; content merged into perf panel)
                    self.detail_labels['tests'].setText(f"<b>Tests run:</b> {test_count}")

                    # Read additional metrics from the JSONB metrics dict
                    best_metrics = best.get('metrics') or {}
                    win_count = best_metrics.get('win_count', 0)
                    loss_count = best_metrics.get('loss_count', 0)
                    # Fall back to deriving counts from win_rate if not persisted yet
                    if win_count == 0 and loss_count == 0 and total_trades > 0:
                        win_count = round(total_trades * win_rate / 100)
                        loss_count = total_trades - win_count
                    profit_factor = best.get('profit_factor') or best_metrics.get('profit_factor', 0) or 0
                    max_drawdown_pct = best.get('max_drawdown_pct') or best_metrics.get('max_drawdown_pct', 0) or 0
                    total_return_pct = best.get('total_return_pct') or best_metrics.get('total_return_pct', 0) or 0
                    sortino_ratio = best_metrics.get('sortino_ratio', 0) or 0
                    calmar_ratio = best_metrics.get('calmar_ratio', 0) or 0
                    std_deviation = best_metrics.get('std_deviation', 0) or 0

                    # Colour helpers — values fetched from styles palette via get_color()
                    _c_success = get_color('success')
                    _c_warning = get_color('warning')
                    _c_error   = get_color('error')
                    _c_muted   = get_color('text_muted')
                    _c_label   = get_color('text_label')
                    _c_border  = get_color('border')

                    def _ratio_color(val):
                        """Green >1.0, amber 0.5–1.0, red <0.5."""
                        if val > 1.0:
                            return _c_success
                        elif val >= 0.5:
                            return _c_warning
                        return _c_error

                    _win_rate_color  = _c_success if win_rate >= 50 else _c_error
                    _return_color    = _c_success if total_return_pct >= 0 else _c_error
                    _pf_color        = _c_success if profit_factor > 1.5 else (_c_warning if profit_factor >= 1.0 else _c_error)
                    _sharpe_color    = _ratio_color(sharpe)
                    _sortino_color   = _ratio_color(sortino_ratio)
                    _calmar_color    = _ratio_color(calmar_ratio)
                    _return_sign     = '+' if total_return_pct > 0 else ''
                    _dd_display      = f"-{abs(max_drawdown_pct):.1f}%" if max_drawdown_pct != 0 else "0.0%"

                    _section_style = f"color:{_c_muted};letter-spacing:1px;"
                    _divider       = f'<hr style="border:none;border-top:1px solid {_c_border};margin:4px 0">'
                    # Fixed-width label column (120px) keeps label flush against the value column;
                    # value column expands to fill remaining space.
                    _lbl_style     = 'width="120" style="white-space:nowrap;"'
                    _val_style     = 'style="white-space:nowrap;"'
                    _tbl_open      = '<table cellpadding="0" cellspacing="0" width="100%">'
                    _tbl_close     = '</table>'

                    perf_text = (
                        f'<span style="{_section_style}">TRADE STATS</span>'
                        f'{_tbl_open}'
                        f'<tr><td {_lbl_style}>Trades</td><td {_val_style} align="right"><b>{total_trades}</b></td></tr>'
                        f'<tr><td {_lbl_style}>Win Rate</td><td {_val_style} align="right"><b style="color:{_win_rate_color}">{win_rate:.1f}%</b></td></tr>'
                        f'<tr><td {_lbl_style}>W / L</td><td {_val_style} align="right">{win_count} / {loss_count}</td></tr>'
                        f'{_tbl_close}'
                        f'{_divider}'
                        f'<span style="{_section_style}">RETURNS</span>'
                        f'{_tbl_open}'
                        f'<tr><td {_lbl_style}>Return</td><td {_val_style} align="right"><b style="color:{_return_color}">{_return_sign}{total_return_pct:.1f}%</b></td></tr>'
                        f'<tr><td {_lbl_style}>Prof. Factor</td><td {_val_style} align="right"><b style="color:{_pf_color}">{profit_factor:.2f}</b></td></tr>'
                        f'{_tbl_close}'
                        f'{_divider}'
                        f'<span style="{_section_style}">RISK METRICS</span>'
                        f'{_tbl_open}'
                        f'<tr><td {_lbl_style}>Sharpe</td><td {_val_style} align="right"><b style="color:{_sharpe_color}">{sharpe:.2f}</b></td></tr>'
                        f'<tr><td {_lbl_style}>Sortino</td><td {_val_style} align="right"><b style="color:{_sortino_color}">{sortino_ratio:.2f}</b></td></tr>'
                        f'<tr><td {_lbl_style}>Calmar</td><td {_val_style} align="right"><b style="color:{_calmar_color}">{calmar_ratio:.2f}</b></td></tr>'
                        f'<tr><td {_lbl_style}>Max DD</td><td {_val_style} align="right"><b style="color:{_c_error}">{_dd_display}</b></td></tr>'
                        f'<tr><td {_lbl_style}>Std Dev</td><td {_val_style} align="right">{std_deviation:.4f}</td></tr>'
                        f'{_tbl_close}'
                    )
                    self.detail_labels['performance'].setText(perf_text)
                    
                    # Quality badge — multi-metric composite score
                    # The raw Sharpe stored in the DB is avg_pnl/std_dev (not annualised),
                    # so values are typically 0.05–0.5.  We therefore build a composite
                    # score from three independent signals that each operate in their own
                    # natural range, then map the total to a quality label.
                    #
                    # Scoring rubric (4 pts max):
                    #   Win rate  >= 60%   → 2 pts  |  >= 45% → 1 pt
                    #   Profit factor >= 1.5 → 2 pts  |  >= 1.0 → 1 pt
                    #   Raw Sharpe >= 0.15 → 2 pts  |  >= 0.05 → 1 pt  (DB formula: avg_pnl/std_dev)
                    #   Total trades >= 20  → 1 pt  (sufficient sample)
                    #
                    # Total  7 pts max → Excellent ≥6 | Good ≥4 | Fair ≥2 | Poor <2
                    _wr   = float(win_rate)    if win_rate    is not None else 0.0
                    _pf   = float(profit_factor) if profit_factor is not None else 0.0
                    _sh   = float(sharpe)      if sharpe      is not None else 0.0
                    _tt   = int(total_trades)  if total_trades is not None else 0

                    _score = 0
                    # Win rate
                    if _wr >= 60:
                        _score += 2
                    elif _wr >= 45:
                        _score += 1
                    # Profit factor
                    if _pf >= 1.5:
                        _score += 2
                    elif _pf >= 1.0:
                        _score += 1
                    # Raw Sharpe (DB stores avg_pnl/std_dev, not annualised)
                    if _sh >= 0.15:
                        _score += 2
                    elif _sh >= 0.05:
                        _score += 1
                    # Sample size bonus
                    if _tt >= 20:
                        _score += 1

                    if _score >= 6:
                        quality = "🟢 Excellent"
                        _quality_color = get_color('success')
                    elif _score >= 4:
                        quality = "🟡 Good"
                        _quality_color = get_color('success')
                    elif _score >= 2:
                        quality = "🟠 Fair"
                        _quality_color = get_color('warning')
                    else:
                        quality = "🔴 Poor"
                        _quality_color = get_color('error')
                    self.detail_labels['status'].setStyleSheet(
                        f"color: {_quality_color}; padding: 4px 6px;"
                    )
                    self.detail_labels['status'].setText(f"<b>Quality:</b> {quality}")
                else:
                    self.detail_labels['tests'].setText(f"<b>Tests Run:</b> 0<br>⚠️ No backtest data")
                    self.detail_labels['performance'].setText("<b>Run backtest to see:</b><br>• Sharpe Ratio<br>• Win Rate<br>• Trade Stats")
                    self.detail_labels['status'].setStyleSheet(
                        f"color: {get_color('text_muted')}; padding: 4px 6px;"
                    )
                    self.detail_labels['status'].setText("<b>Quality:</b> 🔵 Untested")
                    
            except Exception as e:
                logger.error(f"Error loading test results: {e}")
                self.detail_labels['tests'].setText(f"<b>Tests:</b> Error loading")
                self.detail_labels['performance'].setText("<b>Database error</b><br>Check logs for details")
                self.detail_labels['status'].setStyleSheet(
                    f"color: {get_color('warning')}; padding: 4px 6px;"
                )
                self.detail_labels['status'].setText("<b>Quality:</b> ⚠️ Error")
            
            # Show the panel
            self.details_frame.setVisible(True)
            
            # NOTE: Do NOT call _recalculate_details_stretches() here!
            # It causes columns to change width when switching strategies.
            # Columns should remain equal width (1:1:1) as set in _init_ui()
            
        except Exception as e:
            logger.error(f"Error populating details: {e}")
            import traceback
            traceback.print_exc()
            self.details_frame.setVisible(False)
    
    def _recalculate_details_stretches(self):
        """
        SMART CONTENT-AWARE RESIZING
        Dynamically adjust row stretches based on content overflow
        
        Algorithm:
        1. Measure overflow in each row's labels
        2. If ANY label has overflow: Give that row more stretch
        3. If NO label has overflow: Equal stretch (all fit)
        4. Apply new stretch factors
        """
        if not self.details_frame.isVisible():
            return
        
        # Get the details layout
        details_layout = self.details_frame.layout()
        if not isinstance(details_layout, QGridLayout):
            return
        
        # Map row index to labels (excluding row 0 which is titles)
        # NOTE: Exclude 'blocks' label since it spans rows 1-2 (would cause both to resize)
        row_labels = {
            1: [self.detail_labels.get('name'), self.detail_labels.get('tests')],
            2: [self.detail_labels.get('description'), self.detail_labels.get('performance')],
            3: [self.detail_labels.get('meta'), self.detail_labels.get('signals'), 
                self.detail_labels.get('status')]
        }
        
        # Calculate overflow for each row
        # PADDING TOLERANCE: 10px (5px top + 5px bottom)
        # Text is considered "fitting" if overflow <= 10px
        PADDING_TOLERANCE = 10
        
        row_overflows = {}
        for row_idx, labels in row_labels.items():
            max_overflow = 0
            for label in labels:
                if label and label.isVisible():
                    overflow = ContentMeasurement.calculate_overflow_pixels(label)
                    # Apply padding tolerance - text within 10px is considered "fitting"
                    if overflow > PADDING_TOLERANCE:
                        max_overflow = max(max_overflow, overflow - PADDING_TOLERANCE)
            row_overflows[row_idx] = max_overflow
        
        # Determine stretch factors
        total_overflow = sum(row_overflows.values())
        
        if total_overflow == 0:
            # All text fits - equal stretch (minimal)
            details_layout.setRowStretch(1, 1)
            details_layout.setRowStretch(2, 1)
            details_layout.setRowStretch(3, 1)
        else:
            # Distribute stretch based on overflow
            # Rows with more overflow get more stretch
            for row_idx, overflow in row_overflows.items():
                if overflow > 0:
                    # Proportional to overflow amount
                    # 50px overflow = 1 unit stretch
                    stretch = max(1, int(overflow / 50))
                else:
                    # Fits - minimum stretch (stay small)
                    stretch = 0
                
                details_layout.setRowStretch(row_idx, stretch)
    
    def _calculate_max_details_height(self) -> int:
        """
        Calculate maximum allowed height for details panel
        
        Returns min of:
        1. 50% of window height
        2. Content-fit height (height when all text fits perfectly)
        """
        # Option 1: 50% of window
        window_height = self.height()
        fifty_percent = window_height // 2
        
        # Option 2: Content-fit (all content visible with no overflow)
        content_fit = self._calculate_content_fit_height()
        
        # Use the smaller of the two
        return min(fifty_percent, content_fit)
    
    def _calculate_content_fit_height(self) -> int:
        """
        Calculate height needed for all content to fit perfectly
        
        Measures all labels and sums required heights + margins
        """
        if not self.details_frame.isVisible():
            return 450  # Minimum
        
        total_height = 0
        
        # Measure each label's ideal height
        for label in self.detail_labels.values():
            if label and label.isVisible():
                content_height = ContentMeasurement.get_content_height(label)
                total_height += content_height
        
        # Add grid layout spacing and margins
        details_layout = self.details_frame.layout()
        if isinstance(details_layout, QGridLayout):
            # Add spacing between rows (4 rows including title row)
            total_height += details_layout.spacing() * 4
            
            # Add content margins
            margins = details_layout.contentsMargins()
            total_height += margins.top() + margins.bottom()
        
        # Add frame border and padding
        total_height += 20  # Extra padding for border/frame
        
        # Enforce minimum
        return max(450, total_height)
    
    def resizeEvent(self, event):
        """
        Handle resize events to:
        1. Enforce max height constraint on details panel
        2. Recalculate stretch factors for smart resizing
        3. STOP resizing when all text fits with padding
        """
        super().resizeEvent(event)
        
        if hasattr(self, 'details_frame') and self.details_frame.isVisible():
            # First recalculate stretches to know if text fits
            self._recalculate_details_stretches()
            
            # Calculate max height (content-fit or 50% window)
            max_height = self._calculate_max_details_height()
            
            # STRICT ENFORCEMENT: Always set max height
            # This prevents panel from growing beyond content-fit
            self.details_frame.setMaximumHeight(max_height)
    
    def _on_selection_changed(self):
        """Handle table selection change"""
        selected = self.table.selectedItems()
        
        if selected:
            row = selected[0].row()
            name_item = self.table.item(row, 0)
            strategy_data = name_item.data(Qt.ItemDataRole.UserRole)
            
            self.selected_strategy_id = strategy_data['strategy_id']
            self.selected_version_id = strategy_data['version_id']
            
            # Populate details panel with selected strategy
            self._populate_details_panel(self.selected_version_id)
            
            self.open_btn.setEnabled(True)
            if self.mode == 'open':
                self.delete_btn.setEnabled(True)
                self.duplicate_btn.setEnabled(True)
                self.export_btn.setEnabled(True)
        else:
            self.selected_strategy_id = None
            self.selected_version_id = None
            self.details_frame.setVisible(False)
            self.open_btn.setEnabled(False)
            if self.mode == 'open':
                self.delete_btn.setEnabled(False)
                self.duplicate_btn.setEnabled(False)
                self.export_btn.setEnabled(False)
    
    def _on_double_click(self, item: QTableWidgetItem):
        """Handle double-click on table item"""
        self.accept()
    
    def _on_delete(self):
        """Handle delete button with modal choice: entire strategy or specific version"""
        if not self.selected_strategy_id:
            return
        
        try:
            # Get current version for display
            version = self.db.strategy.get_strategy_version(self.selected_version_id)
            if not version:
                return
            
            # Get all versions to show in dropdown
            all_versions = self.db.strategy.get_strategy_versions(self.selected_strategy_id)
            
            # Show choice modal
            from PyQt5.QtWidgets import QDialog, QVBoxLayout, QLabel, QRadioButton, QComboBox, QDialogButtonBox, QButtonGroup, QListWidget, QListWidgetItem
            
            dialog = QDialog(self)
            dialog.setWindowTitle("Delete Strategy")
            dialog.setStyleSheet(get_main_stylesheet())
            dialog.setMinimumWidth(600)
            dialog.setMinimumHeight(400)
            
            layout = QVBoxLayout(dialog)
            layout.setSpacing(12)
            layout.setContentsMargins(20, 20, 20, 20)
            
            # Title
            title = QLabel("What would you like to delete?")
            title.setFont(create_font(12, bold=True))
            title.setStyleSheet(f"color: {get_color('text_primary')};")
            layout.addWidget(title)
            
            # Warning message
            warning = QLabel("⚠️ This action cannot be undone!")
            warning.setFont(create_font(10))
            warning.setStyleSheet(f"color: #FFA500; padding: 8px 0px;")
            layout.addWidget(warning)
            
            # Options
            button_group = QButtonGroup(dialog)
            
            version_count = len(all_versions)
            # Use hyphen format: "Delete entire strategy - All X version(s)"
            option1 = QRadioButton(f"Delete entire strategy - All {version_count} version{'s' if version_count != 1 else ''}")
            option1.setFont(create_font(10))
            option1.setStyleSheet(f"color: {get_color('text_secondary')};")
            button_group.addButton(option1, 1)
            layout.addWidget(option1)
            
            option2 = QRadioButton("Delete specific version only")
            option2.setFont(create_font(10))
            option2.setStyleSheet(f"color: {get_color('text_secondary')};")
            button_group.addButton(option2, 2)
            layout.addWidget(option2)
            
            # CRITICAL: If only 1 version, disable "specific version" option
            # User must delete entire strategy (can't delete last version)
            if version_count == 1:
                option2.setEnabled(False)
                option1.setChecked(True)  # Force entire strategy deletion
            else:
                option2.setChecked(True)  # Default to specific version when multiple exist
            
            # Version selector (visible by default since option 2 is default)
            # MULTI-SELECT: Allow users to select multiple versions at once
            version_label = QLabel("Select version(s) to delete (Ctrl+Click for multiple):")
            version_label.setFont(create_font(10))
            version_label.setStyleSheet(f"color: {get_color('text_secondary')};")
            layout.addWidget(version_label)
            
            # Use QListWidget instead of QComboBox for multi-selection
            version_list = QListWidget()
            version_list.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)  # Multi-select with Ctrl/Shift
            version_list.setMinimumHeight(150)  # Show multiple items
            version_list.setStyleSheet(get_input_field_stylesheet())
            
            for ver in all_versions:
                item = QListWidgetItem(f"v{ver['version_number']} - {ver['created_at']}")
                item.setData(Qt.ItemDataRole.UserRole, ver['version_id'])
                version_list.addItem(item)
                # Mark current version as default selection
                if ver['version_id'] == self.selected_version_id:
                    item.setSelected(True)
            
            layout.addWidget(version_list)
            
            # Show/hide version selector based on selection
            def on_option_changed():
                show_selector = option2.isChecked()
                version_label.setVisible(show_selector)
                version_list.setVisible(show_selector)
            
            option1.toggled.connect(on_option_changed)
            option2.toggled.connect(on_option_changed)
            
            # Buttons
            buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
            buttons.button(QDialogButtonBox.Ok).setText("Delete")
            buttons.button(QDialogButtonBox.Ok).setStyleSheet(get_danger_button_stylesheet())
            buttons.button(QDialogButtonBox.Cancel).setStyleSheet(get_secondary_button_stylesheet())
            buttons.accepted.connect(dialog.accept)
            buttons.rejected.connect(dialog.reject)
            layout.addWidget(buttons)
            
            # Show modal
            if dialog.exec_() != QDialog.Accepted:
                return  # User cancelled
            
            # Execute based on choice
            if option1.isChecked():
                # Delete entire strategy (all versions)
                deleted = self.db.strategy.delete_strategy(self.selected_strategy_id)
                
                if deleted:
                    # Emit signal to notify main window (entire strategy deleted)
                    self.strategy_deleted.emit(str(self.selected_strategy_id), True)
                    
                    from .alert_dialog import show_success
                    show_success(self, "Delete Strategy", "Success", 
                               f"Strategy '{version['name']}' and all {version_count} version{'s' if version_count != 1 else ''} deleted")
                else:
                    from .alert_dialog import show_error
                    show_error(self, "Delete Strategy", "Error", "Strategy not found")
            else:
                # Delete specific versions (MULTI-SELECT support)
                selected_items = version_list.selectedItems()
                
                if not selected_items:
                    from .alert_dialog import show_error
                    show_error(self, "Delete Versions", "Error", "No versions selected")
                    return
                
                # Collect version IDs to delete
                version_ids_to_delete = []
                for item in selected_items:
                    version_id = item.data(Qt.ItemDataRole.UserRole)
                    version_ids_to_delete.append(version_id)
                
                # Delete all selected versions
                deleted_count = 0
                for version_id in version_ids_to_delete:
                    try:
                        self.db.strategy.delete_strategy_version(version_id)
                        deleted_count += 1
                    except Exception as e:
                        logger.error(f"Failed to delete version {version_id}: {e}")
                
                if deleted_count > 0:
                    # Emit signal to notify main window (versions deleted, not entire strategy)
                    self.strategy_deleted.emit(str(self.selected_strategy_id), False)
                    
                    from .alert_dialog import show_success
                    show_success(self, "Delete Versions", "Success", 
                               f"Deleted {deleted_count} version{'s' if deleted_count != 1 else ''} successfully")
                else:
                    from .alert_dialog import show_error
                    show_error(self, "Delete Versions", "Error", "Failed to delete versions")
            
            # Reload strategies
            self._load_strategies()
            
        except Exception as e:
            from .alert_dialog import show_error
            show_error(self, "Delete Error", "Error", f"Failed to delete:\n{e}")
            import traceback
            traceback.print_exc()
    
    def _on_duplicate(self):
        """Handle duplicate button with modal choice: new version or new strategy"""
        if not self.selected_version_id:
            return
        
        try:
            # Get current version
            version = self.db.strategy.get_strategy_version(self.selected_version_id)
            if not version:
                return
            
            # Show choice modal using QuestionDialog pattern from alert_dialog
            from PyQt5.QtWidgets import QDialog, QVBoxLayout, QLabel, QRadioButton, QLineEdit, QDialogButtonBox, QButtonGroup
            
            dialog = QDialog(self)
            dialog.setWindowTitle("Duplicate Strategy")
            dialog.setStyleSheet(get_main_stylesheet())
            dialog.setMinimumWidth(400)
            
            layout = QVBoxLayout(dialog)
            layout.setSpacing(16)
            layout.setContentsMargins(20, 20, 20, 20)
            
            # Title
            title = QLabel("How would you like to duplicate this strategy?")
            title.setFont(create_font(12, bold=True))
            title.setStyleSheet(f"color: {get_color('text_primary')};")
            layout.addWidget(title)
            
            # Options
            button_group = QButtonGroup(dialog)
            
            option1 = QRadioButton("Duplicate as new version of existing strategy")
            option1.setFont(create_font(10))
            option1.setStyleSheet(f"color: {get_color('text_secondary')};")
            option1.setChecked(True)
            button_group.addButton(option1, 1)
            layout.addWidget(option1)
            
            option2 = QRadioButton("Duplicate as new strategy")
            option2.setFont(create_font(10))
            option2.setStyleSheet(f"color: {get_color('text_secondary')};")
            button_group.addButton(option2, 2)
            layout.addWidget(option2)
            
            # New strategy name input (only shown if option 2 selected)
            name_label = QLabel("New Strategy Name:")
            name_label.setFont(create_font(10))
            name_label.setStyleSheet(f"color: {get_color('text_secondary')};")
            name_label.setVisible(False)
            layout.addWidget(name_label)
            
            name_input = QLineEdit()
            name_input.setText(f"{version['name']} (Copy)")
            name_input.setStyleSheet(get_input_field_stylesheet())
            name_input.setVisible(False)
            layout.addWidget(name_input)
            
            # Show/hide name input based on selection
            def on_option_changed():
                show_input = option2.isChecked()
                name_label.setVisible(show_input)
                name_input.setVisible(show_input)
            
            option1.toggled.connect(on_option_changed)
            option2.toggled.connect(on_option_changed)
            
            # Buttons
            buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
            buttons.button(QDialogButtonBox.Ok).setStyleSheet(get_primary_button_stylesheet())
            buttons.button(QDialogButtonBox.Cancel).setStyleSheet(get_secondary_button_stylesheet())
            buttons.accepted.connect(dialog.accept)
            buttons.rejected.connect(dialog.reject)
            layout.addWidget(buttons)
            
            # Show modal
            if dialog.exec_() != QDialog.Accepted:
                return  # User cancelled
            
            # Execute based on choice
            if option1.isChecked():
                # Duplicate as new version of SAME strategy
                version_data = {
                    'strategy_id': self.selected_strategy_id,  # SAME strategy
                    'name': version['name'],  # Keep same name
                    'description': version.get('description', ''),
                    'strategy_type': version.get('strategy_type', 'Bullish'),
                    'blocks': version['blocks'],
                    'signals': version['signals'],
                    'parameters': version['parameters'],
                    'entry_conditions': version['entry_conditions'],
                    'exit_conditions': version['exit_conditions'],
                    'risk_management': version['risk_management'],
                    'backtest_config': version['backtest_config'],
                    'tags': version.get('tags', [])
                }
                
                self.db.strategy.create_strategy_version(version_data)
                
                from .alert_dialog import show_success
                show_success(self, "Duplicate Strategy", "Success", 
                           f"New version created for strategy: {version['name']}")
            else:
                # Duplicate as NEW strategy
                new_name = name_input.text().strip()
                if not new_name:
                    from .alert_dialog import show_error
                    show_error(self, "Duplicate Strategy", "Error", "Strategy name cannot be empty")
                    return
                
                new_strategy_id = self.db.strategy.create_strategy(new_name)
                
                version_data = {
                    'strategy_id': new_strategy_id,  # NEW strategy
                    'name': new_name,
                    'description': version.get('description', ''),
                    'strategy_type': version.get('strategy_type', 'Bullish'),
                    'blocks': version['blocks'],
                    'signals': version['signals'],
                    'parameters': version['parameters'],
                    'entry_conditions': version['entry_conditions'],
                    'exit_conditions': version['exit_conditions'],
                    'risk_management': version['risk_management'],
                    'backtest_config': version['backtest_config'],
                    'tags': version.get('tags', [])
                }
                
                self.db.strategy.create_strategy_version(version_data)
                
                from .alert_dialog import show_success
                show_success(self, "Duplicate Strategy", "Success", 
                           f"New strategy created: {new_name}")
            
            # Reload strategies
            self._load_strategies()
            
        except Exception as e:
            from .alert_dialog import show_error
            show_error(self, "Duplicate Strategy", "Error", f"Failed to duplicate strategy:\n{e}")
    
    def _on_import(self):
        """Handle import from JSON - reuse main window code"""
        try:
            from PyQt5.QtWidgets import QFileDialog
            
            # Get last directory
            settings = QSettings("BTC_Engine", "StrategyBuilder")
            last_dir = settings.value("lastDirectory", "")
            
            # Create file dialog with 2x size
            dialog = QFileDialog(self)
            dialog.setWindowTitle("Import Strategy from JSON")
            dialog.setNameFilter("Strategy Files (*.json);;All Files (*)")
            dialog.setDirectory(last_dir)
            dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
            dialog.setOption(QFileDialog.Option.DontUseNativeDialog, False)
            
            # Set 2x larger size (default ~800x600, make it 1600x1200)
            dialog.resize(1600, 1200)
            
            # Show dialog and get result
            if dialog.exec_() != QFileDialog.Accepted:
                return  # User cancelled
            
            files = dialog.selectedFiles()
            if not files:
                return
            
            filename = files[0]
            
            if not filename:
                return  # User cancelled
            
            # Load and save to database (same logic as main window)
            from src.strategy_builder.integration.strategy_builder_orchestrator import StrategyBuilderOrchestrator
            
            orch = StrategyBuilderOrchestrator()
            result = orch.load_strategy(filename)
            
            if not result.success:
                from .alert_dialog import show_error
                show_error(self, "Import Failed", "Error", 
                         f"Failed to import strategy:\n{result.message}")
                return
            
            # Get config from orchestrator
            config = orch.get_current_config()
            
            # Create new strategy in database
            strategy_id = self.db.strategy.create_strategy(config.name)
            
            # Convert config to dict for database
            config_dict = orch.persistence._config_to_dict(config)
            
            # Save as new version
            version_data = {
                'strategy_id': strategy_id,
                'name': config.name,
                'description': getattr(config, 'description', ''),
                'blocks': config_dict.get('blocks', []),
                'signals': {},
                'parameters': {},
                'entry_conditions': {},
                'exit_conditions': {},
                'risk_management': {},
                'backtest_config': {},
                'tags': []
            }
            
            self.db.strategy.create_strategy_version(version_data)
            
            # Reload strategies
            self._load_strategies()
            
            from .alert_dialog import show_success
            show_success(self, "Import Successful", "Success", 
                       f"Strategy imported from JSON:\n{filename}\n\nSaved to database as: {config.name}")
            
        except Exception as e:
            from .alert_dialog import show_error
            show_error(self, "Import Error", "Error", 
                     f"Error importing strategy:\n{str(e)}")
            import traceback
            traceback.print_exc()
    
    def _on_export(self):
        """Handle export to JSON button click"""
        if not self.selected_version_id:
            return
        
        try:
            from PyQt5.QtWidgets import QFileDialog
            
            # Get strategy version
            version = self.db.strategy.get_strategy_version(self.selected_version_id)
            
            if not version:
                from .alert_dialog import show_error
                show_error(self, "Export Failed", "Error", "Strategy version not found")
                return
            
            # Get save filename
            settings = QSettings("BTC_Engine", "StrategyBuilder")
            last_dir = settings.value("lastDirectory", "")
            
            filename, _ = QFileDialog.getSaveFileName(
                self,
                "Export Strategy to JSON",
                f"{last_dir}/{version['name']}.json",
                "Strategy Files (*.json);;All Files (*)"
            )
            
            if not filename:
                return  # User cancelled
            
            # Prepare export data (convert from persistence format to file format)
            from src.strategy_builder.integration.strategy_builder_orchestrator import StrategyBuilderOrchestrator
            
            # Create temporary orchestrator for export
            orch = StrategyBuilderOrchestrator()
            
            # Build config dict for export
            export_dict = {
                'name': version['name'],
                'description': version.get('description', ''),
                'blocks': version['blocks']
            }
            
            # Use persistence to convert to full config then back to file format
            config = orch.persistence._dict_to_config(export_dict)
            
            # Now save using orchestrator's save method
            result = orch.save_strategy(filename)
            
            if result.success:
                from .alert_dialog import show_success
                show_success(
                    self,
                    "Export Successful",
                    "Success",
                    f"Strategy exported to:\n{filename}"
                )
            else:
                from .alert_dialog import show_error
                show_error(self, "Export Failed", "Error", f"Failed to export:\n{result.message}")
                
        except Exception as e:
            from .alert_dialog import show_error
            show_error(self, "Export Failed", "Error", f"Error exporting strategy:\n{e}")
            import traceback
            traceback.print_exc()
    
    def _on_table_version_changed(self, row: int, index: int):
        """Handle version dropdown change in table"""
        if index < 0:
            return
        
        # Get the combo box from the table
        version_combo = self.table.cellWidget(row, 2)
        if not version_combo:
            return
        
        # Get the version_id from combo box
        version_id = version_combo.itemData(index)
        
        if version_id:
            # Update the stored version_id for this row
            name_item = self.table.item(row, 0)
            if name_item:
                strategy_data = name_item.data(Qt.ItemDataRole.UserRole)
                strategy_data['version_id'] = version_id
                name_item.setData(Qt.ItemDataRole.UserRole, strategy_data)
            
            # Determine if this row is currently selected.
            # Use selectedItems() rather than currentRow() because currentRow() can
            # become stale (-1) when the combo popup takes focus away from the table.
            selected_rows = {item.row() for item in self.table.selectedItems()}
            row_is_selected = (row in selected_rows)
            
            if row_is_selected:
                # Row is selected: update the open-target version and refresh details
                self.selected_version_id = version_id
                self._populate_details_panel(version_id)
            else:
                # Row is not yet selected but user is interacting with its combo.
                # Always refresh the details panel so the user can preview the new
                # version, but do NOT update selected_version_id (which tracks the
                # strategy that will be opened when "Open" is clicked).
                self._populate_details_panel(version_id)
    
    def _on_version_changed(self, index: int):
        """Handle version selector change"""
        if index < 0:
            return
        
        # Get version_id from combo box data
        version_id = self.version_selector.itemData(index)
        
        if version_id:
            self.selected_version_id = version_id
            # Could update table row to show selected version details
    
    def get_selected_strategy(self) -> tuple[Optional[str], Optional[str]]:
        """
        Get selected strategy and version IDs
        
        Returns:
            Tuple of (strategy_id, version_id) or (None, None)
        """
        return (self.selected_strategy_id, self.selected_version_id)
    
    def accept(self):
        """Handle accept - emit signal and close"""
        if self.selected_strategy_id and self.selected_version_id:
            # Convert version_id to string (may be UUID from database)
            self.strategy_selected.emit(
                str(self.selected_strategy_id), 
                str(self.selected_version_id)
            )
        self._save_settings()
        self.close()
    
    def reject(self):
        """Handle reject - just close"""
        self._save_settings()
        self.close()
    
    def _restore_non_geometry_settings(self):
        """Restore non-geometry settings (splitter sizes).

        Geometry and maximized state are restored in showEvent via
        WindowGeometryMixin._restore_window_geometry() to avoid the Qt5
        window-state desync bug where restoreGeometry() before show() sets
        the maximized flag without actually maximizing the OS window.
        """
        settings = QSettings("BTC_Engine", "StrategyBuilder")
        splitter_sizes = settings.value("strategyBrowser/splitterSizes")
        if splitter_sizes:
            self.content_splitter.restoreState(splitter_sizes)

    def _restore_settings(self):
        """Deprecated: kept for internal call compatibility — delegates to split helpers."""
        self._restore_non_geometry_settings()

    def _save_settings(self):
        """Save window geometry and state"""
        settings = QSettings("BTC_Engine", "StrategyBuilder")
        self._save_window_geometry()
        # Save splitter sizes (user's preferred table/details ratio)
        settings.setValue("strategyBrowser/splitterSizes", self.content_splitter.saveState())
    
    def showEvent(self, event):
        """Called when window is shown - apply hand cursors to all widgets"""
        super().showEvent(event)
        # Restore geometry via mixin (safe to call here — window is shown)
        self._restore_window_geometry(event)
        # Apply hand cursor AFTER Qt finishes all stylesheet processing
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))

    def closeEvent(self, event):
        """Handle window close"""
        self._save_settings()
        if self.db:
            self.db.close()
        super().closeEvent(event)
