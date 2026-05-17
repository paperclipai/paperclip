"""
Stepper Ribbon - Workflow Progress Component

Shows the 4-step workflow progression in the toolbar:
1. Design Strategy
2. Validate
3. Test / Optimize
4. Publish

Author: Strategy Builder Team
Date: 2026-01-17
"""

from typing import Optional, Set
from PyQt5.QtWidgets import (
    QWidget, QHBoxLayout, QLabel, QPushButton
)
from PyQt5.QtCore import pyqtSignal, Qt, QTimer

from src.strategy_builder.ui.styles import (
    create_font,
    set_hand_cursor,
    get_stepper_button_style,
    get_stepper_arrow_style,
    get_color,
)


class StepperRibbon(QWidget):
    """
    Stepper ribbon showing workflow progress.

    Steps:
    1. Design Strategy
    2. Validate
    3. Test / Optimize
    4. Publish Status

    Signals:
        step_clicked(int): Emitted when step is clicked
    """

    step_clicked = pyqtSignal(int)

    STEPS = [
        {"name": "Design", "icon": "📝", "tooltip": "Design your trading strategy"},
        {"name": "Validate", "icon": "✓", "tooltip": "Validate strategy configuration"},
        {"name": "Test / Optimize", "icon": "🧪", "tooltip": "Run backtest and optimize parameters with Optimizer v3"},
        {"name": "Publish", "icon": "🚀", "tooltip": "Set publish status"}
    ]

    BUTTON_MIN_WIDTH = 140
    BUTTON_MIN_HEIGHT = 36

    def __init__(self, parent: Optional[QWidget] = None):
        """Initialize the stepper ribbon."""
        super().__init__(parent)
        self.current_step = 0
        self.completed_steps: Set[int] = set()
        self.error_steps: Set[int] = set()

        self.step_buttons = []
        self.arrow_labels = []

        self._init_ui()

    def _init_ui(self):
        """Initialize the user interface."""
        layout = QHBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(5)

        arrow_font = create_font(12, bold=True)

        for idx, step in enumerate(self.STEPS):
            btn = QPushButton(f"{step['icon']} {step['name']}")
            btn.setToolTip(step['tooltip'])
            btn.setMinimumWidth(self.BUTTON_MIN_WIDTH)
            btn.setMinimumHeight(self.BUTTON_MIN_HEIGHT)
            set_hand_cursor(btn)
            btn.clicked.connect(lambda checked, i=idx: self._on_step_clicked(i))

            self.step_buttons.append(btn)
            layout.addWidget(btn)

            if idx < len(self.STEPS) - 1:
                arrow = QLabel("→")
                arrow.setFont(arrow_font)
                arrow.setStyleSheet(get_stepper_arrow_style())
                self.arrow_labels.append(arrow)
                layout.addWidget(arrow)

        layout.addStretch()

        self.setLayout(layout)

        self._update_display()

    def showEvent(self, event):
        """Called when widget is shown - recalculate centering."""
        super().showEvent(event)
        QTimer.singleShot(100, self._recalculate_centering)

    def resizeEvent(self, event):
        """Called when widget or window is resized - recalculate centering."""
        super().resizeEvent(event)
        self._recalculate_centering()

    def _recalculate_centering(self):
        """Dynamically calculate left margin to center stepper in window."""
        toolbar = self.parent()
        if not toolbar:
            return

        main_window = toolbar.parent()
        if not main_window:
            return

        window_width = main_window.width()

        stepper_width = 0
        for btn in self.step_buttons:
            stepper_width += btn.minimumWidth()
        for arrow in self.arrow_labels:
            stepper_width += arrow.sizeHint().width()
        num_widgets = len(self.step_buttons) + len(self.arrow_labels)
        stepper_width += 5 * (num_widgets - 1)
        stepper_width += 10

        toolbar_buttons_width = 0
        for action in toolbar.actions():
            widget = toolbar.widgetForAction(action)
            if widget == self:
                break
            if widget:
                toolbar_buttons_width += widget.width()
            else:
                toolbar_buttons_width += 80

        center_pos = (window_width - stepper_width) // 2
        adjusted_toolbar_width = int(toolbar_buttons_width * 1.3)
        left_margin = max(0, center_pos - adjusted_toolbar_width)

        layout = self.layout()
        if layout:
            layout.setContentsMargins(left_margin, 0, 0, 0)

    def _on_step_clicked(self, step: int):
        """Handle step button click."""
        self.step_clicked.emit(step)

    def set_current_step(self, step: int):
        """
        Set the current active step.

        Args:
            step: Step index (0-3)
        """
        if 0 <= step < len(self.STEPS):
            self.current_step = step
            self._update_display()

    def mark_step_complete(self, step: int):
        """
        Mark a step as complete with checkmark.

        Args:
            step: Step index (0-3)
        """
        if 0 <= step < len(self.STEPS):
            self.completed_steps.add(step)
            self.error_steps.discard(step)
            self._update_display()

    def mark_step_error(self, step: int):
        """
        Mark a step as having an error.

        Args:
            step: Step index (0-3)
        """
        if 0 <= step < len(self.STEPS):
            self.error_steps.add(step)
            self.completed_steps.discard(step)
            self._update_display()

    def clear_step_error(self, step: int):
        """
        Clear error state from a step.

        Args:
            step: Step index (0-3)
        """
        if 0 <= step < len(self.STEPS):
            self.error_steps.discard(step)
            self._update_display()

    def reset(self):
        """Reset all steps to initial state."""
        self.current_step = 0
        self.completed_steps.clear()
        self.error_steps.clear()
        self._update_display()

    def reset_all_steps(self):
        """
        Reset all steps to initial state (alias for reset()).

        Clears all completion and error states.
        """
        self.reset()

    def _update_display(self):
        """Update the visual display of all steps."""
        try:
            from PyQt5 import sip
        except ImportError:
            sip = None

        for idx, btn in enumerate(self.step_buttons):
            if sip is not None and sip.isdeleted(btn):
                continue

            step = self.STEPS[idx]

            is_current = (idx == self.current_step)
            is_completed = (idx in self.completed_steps)
            is_error = (idx in self.error_steps)

            icon = step['icon']
            if is_completed:
                icon = "✓"
            elif is_error:
                icon = "✗"

            btn.setText(f"{icon} {step['name']}")

            if is_error:
                btn.setStyleSheet(get_stepper_button_style('error'))
            elif is_completed:
                btn.setStyleSheet(get_stepper_button_style('completed'))
            elif is_current:
                btn.setStyleSheet(get_stepper_button_style('active'))
            else:
                btn.setStyleSheet(get_stepper_button_style('pending'))
