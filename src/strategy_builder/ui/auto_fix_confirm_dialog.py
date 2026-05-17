"""
Auto-Fix Confirmation Dialog - Institutional Grade
Preview and confirm strategy modifications before applying

Author: BTC Trade Engine
Date: 2026-02-02
Sprint: 1.9.2 Auto-Fix Buttons
"""

from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTextEdit, QFrame, QCheckBox
)
from PyQt5.QtCore import Qt
from typing import Dict, Any, Optional

from src.strategy_builder.ui.styles import (
    COLORS, MAIN_STYLESHEET, create_font, create_monospace_font,
    get_success_button_stylesheet, get_secondary_button_stylesheet,
    get_dialog_stylesheet, set_hand_cursor
)


class AutoFixConfirmDialog(QDialog):
    """
    Institutional-grade confirmation dialog for auto-fix operations
    
    Features:
    - Before/After comparison view
    - Impact analysis display
    - Cascading effects warning
    - User option selection (for dead code: disable vs remove)
    
    Tooltip: "Review proposed changes before applying. All fixes can be undone."
    """
    
    def __init__(
        self,
        fix_type: str,
        fix_description: str,
        before_state: Dict[str, Any],
        after_state: Dict[str, Any],
        impact_analysis: str,
        options: Optional[Dict[str, Any]] = None,
        parent=None
    ):
        """
        Initialize confirmation dialog
        
        Args:
            fix_type: Type of fix (e.g., "Switch Direction", "Reduce RECHECK")
            fix_description: Human-readable description of what will change
            before_state: Current configuration state
            after_state: Configuration after applying fix
            impact_analysis: Analysis of what will change and side effects
            options: Optional dictionary of user-selectable options
            parent: Parent widget
        """
        super().__init__(parent)
        self.fix_type = fix_type
        self.fix_description = fix_description
        self.before_state = before_state
        self.after_state = after_state
        self.impact_analysis = impact_analysis
        self.options = options or {}
        self.user_confirmed = False
        self.user_options = {}
        
        self._init_ui()
    
    def _init_ui(self):
        """Initialize dialog UI with institutional styling"""
        self.setWindowTitle("Confirm Auto-Fix")
        self.setModal(True)
        self.setMinimumSize(900, 650)
        # Explicit maximize/minimize hints so the OS title bar includes
        # working maximize and minimize buttons on all platforms.
        self.setWindowFlags(
            Qt.Window |
            Qt.WindowMaximizeButtonHint |
            Qt.WindowMinimizeButtonHint |
            Qt.WindowCloseButtonHint
        )

        # Apply the global dark stylesheet so this dialog is consistent with
        # the rest of the Strategy Builder UI (no custom inline overrides)
        self.setStyleSheet(MAIN_STYLESHEET)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)
        
        # Header
        header = self._create_header()
        layout.addWidget(header)
        
        # Before/After comparison
        comparison = self._create_comparison_view()
        layout.addWidget(comparison, 1)
        
        # Impact analysis
        impact = self._create_impact_panel()
        layout.addWidget(impact)
        
        # Options (if any)
        if self.options:
            options_panel = self._create_options_panel()
            layout.addWidget(options_panel)
        
        # Action buttons
        buttons = self._create_action_buttons()
        layout.addWidget(buttons)
    
    def _create_header(self) -> QFrame:
        """Create dialog header with title and description"""
        frame = QFrame()
        layout = QVBoxLayout(frame)
        layout.setSpacing(8)
        layout.setContentsMargins(0, 0, 0, 0)
        
        title = QLabel(f"🔧 Auto-Fix: {self.fix_type}")
        title.setFont(create_font(14, bold=True))
        title.setStyleSheet(f"color: {COLORS['info']};")
        layout.addWidget(title)
        
        desc = QLabel(self.fix_description)
        desc.setFont(create_font(11))
        desc.setWordWrap(True)
        desc.setStyleSheet(f"color: {COLORS['text_secondary']};")
        layout.addWidget(desc)
        
        return frame
    
    def _create_comparison_view(self) -> QFrame:
        """Create before/after comparison view"""
        frame = QFrame()
        frame.setStyleSheet(f"QFrame {{ background: {COLORS['bg_input']}; border: 1px solid {COLORS['border']}; border-radius: 4px; padding: 8px; }}")
        layout = QHBoxLayout(frame)
        layout.setSpacing(16)
        
        # Before state
        before_panel = QFrame()
        before_layout = QVBoxLayout(before_panel)
        before_layout.setSpacing(8)
        
        before_label = QLabel("❌ Current State (Has Issues)")
        before_label.setFont(create_font(11, bold=True))
        before_label.setStyleSheet(f"color: {COLORS['error']};")
        before_layout.addWidget(before_label)
        
        before_text = QTextEdit()
        before_text.setReadOnly(True)
        before_text.setFont(create_monospace_font(10))
        before_text.setPlainText(self._format_state(self.before_state))
        before_text.setMaximumHeight(300)
        before_layout.addWidget(before_text)
        
        layout.addWidget(before_panel)
        
        # Arrow
        arrow = QLabel("→")
        arrow.setFont(create_font(24, bold=True))
        arrow.setStyleSheet(f"color: {COLORS['info']};")
        arrow.setAlignment(Qt.AlignCenter)
        arrow.setMinimumWidth(40)
        layout.addWidget(arrow)
        
        # After state
        after_panel = QFrame()
        after_layout = QVBoxLayout(after_panel)
        after_layout.setSpacing(8)
        
        after_label = QLabel("✅ After Fix (Corrected)")
        after_label.setFont(create_font(11, bold=True))
        after_label.setStyleSheet(f"color: {COLORS['success']};")
        after_layout.addWidget(after_label)
        
        after_text = QTextEdit()
        after_text.setReadOnly(True)
        after_text.setFont(create_monospace_font(10))
        after_text.setPlainText(self._format_state(self.after_state))
        after_text.setMaximumHeight(300)
        after_layout.addWidget(after_text)
        
        layout.addWidget(after_panel)
        
        return frame
    
    def _create_impact_panel(self) -> QFrame:
        """Create impact analysis panel"""
        frame = QFrame()
        frame.setStyleSheet(f"""
            QFrame {{
                background: {COLORS['bg_info_subtle']};
                border-left: 4px solid {COLORS['info']};
                border-radius: 4px;
                padding: 12px;
            }}
        """)
        layout = QVBoxLayout(frame)
        layout.setSpacing(8)
        
        label = QLabel("📊 Impact Analysis")
        label.setFont(create_font(11, bold=True))
        label.setStyleSheet(f"color: {COLORS['info']};")
        layout.addWidget(label)
        
        analysis = QLabel(self.impact_analysis)
        analysis.setFont(create_font(10))
        analysis.setWordWrap(True)
        analysis.setStyleSheet(f"color: {COLORS['text_primary']};")
        layout.addWidget(analysis)
        
        return frame
    
    def _create_options_panel(self) -> QFrame:
        """Create user options panel (e.g., disable vs remove)"""
        frame = QFrame()
        frame.setStyleSheet(f"""
            QFrame {{
                background: {COLORS['bg_medium']};
                border: 1px solid {COLORS['border']};
                border-radius: 4px;
                padding: 12px;
            }}
        """)
        layout = QVBoxLayout(frame)
        layout.setSpacing(8)
        
        label = QLabel("⚙️ Options")
        label.setFont(create_font(11, bold=True))
        layout.addWidget(label)
        
        # Create checkboxes based on options
        for key, option_data in self.options.items():
            checkbox = QCheckBox(option_data['label'])
            checkbox.setChecked(option_data.get('default', False))
            checkbox.setToolTip(option_data.get('tooltip', ''))
            checkbox.setFont(create_font(10))
            checkbox.stateChanged.connect(lambda state, k=key: self._option_changed(k, state))
            set_hand_cursor(checkbox)
            layout.addWidget(checkbox)
            
            # Store initial value
            self.user_options[key] = option_data.get('default', False)
        
        return frame
    
    def _create_action_buttons(self) -> QFrame:
        """Create action buttons (Apply, Cancel)"""
        frame = QFrame()
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addStretch()
        
        # Cancel button
        cancel_btn = QPushButton("Cancel")
        cancel_btn.setFont(create_font(11))
        cancel_btn.setMinimumWidth(120)
        cancel_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {COLORS['button_secondary']};
                color: white;
                font-weight: bold;
                padding: 8px 16px;
                border-radius: 4px;
            }}
            QPushButton:hover {{
                background-color: {COLORS['button_secondary_hover']};
            }}
        """)
        cancel_btn.clicked.connect(self.reject)
        cancel_btn.setToolTip("Cancel auto-fix - no changes will be made")
        set_hand_cursor(cancel_btn)
        layout.addWidget(cancel_btn)
        
        # Apply button
        apply_btn = QPushButton("✓ Apply Fix")
        apply_btn.setFont(create_font(11, bold=True))
        apply_btn.setMinimumWidth(120)
        apply_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {COLORS['success']};
                color: white;
                font-weight: bold;
                padding: 8px 16px;
                border-radius: 4px;
            }}
            QPushButton:hover {{
                background-color: {COLORS['button_success_hover']};
            }}
            QPushButton:pressed {{
                background-color: {COLORS['button_success']};
            }}
        """)
        apply_btn.clicked.connect(self._apply_fix)
        apply_btn.setToolTip("Apply fix with safety checks - can be undone")
        set_hand_cursor(apply_btn)
        layout.addWidget(apply_btn)
        
        return frame
    
    def _format_state(self, state: Dict[str, Any]) -> str:
        """
        Format state dictionary for display
        
        Converts dictionary to readable text with proper formatting
        """
        lines = []
        for key, value in state.items():
            # Format key to be more readable
            formatted_key = key.replace('_', ' ').title()
            
            # Format value
            if isinstance(value, (list, tuple)):
                if len(value) > 3:
                    formatted_value = f"[{len(value)} items]"
                else:
                    formatted_value = str(value)
            elif isinstance(value, dict):
                formatted_value = f"{{...}} ({len(value)} fields)"
            else:
                formatted_value = str(value)
            
            lines.append(f"{formatted_key}: {formatted_value}")
        
        return "\n".join(lines)
    
    def _option_changed(self, key: str, state: int) -> None:
        """Handle option checkbox state change"""
        self.user_options[key] = (state == Qt.Checked)
    
    def _apply_fix(self) -> None:
        """User confirmed - apply fix"""
        self.user_confirmed = True
        self.accept()
