"""
Settings Dialog — BTC Trade Engine Strategy Builder

Implements the full Settings page under Tools → Settings...

Security architecture per BTCAAAAA-79 SecurityAnalyst recommendations:
  - User section: always visible, shows only user-editable fields
  - Admin section: entirely HIDDEN (not just disabled) until PIN verified
  - Secret fields: masked display (last 4 chars), re-entry required to change
  - No plaintext secrets in editable fields on open — only masked display labels
  - On save: masked sentinel values are skipped (field unchanged)

Author: UIEngineer (BTCAAAAA-80)
"""

from __future__ import annotations

from typing import Optional

from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtWidgets import (
    QComboBox, QDialog, QDialogButtonBox, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QLineEdit, QPushButton, QScrollArea,
    QStackedWidget, QTabWidget, QVBoxLayout, QWidget, QMessageBox,
    QFrame,
)

from src.strategy_builder.ui.settings_service import SettingsService
from src.strategy_builder.ui.styles import (
    COLORS,
    get_main_stylesheet,
    get_primary_button_stylesheet,
    get_secondary_button_stylesheet,
    get_danger_button_stylesheet,
    get_input_field_stylesheet,
    get_tab_widget_stylesheet,
    get_panel_title_stylesheet,
    get_label_style,
    get_transparent_scroll_area_stylesheet,
    create_font,
    apply_hand_cursor_to_buttons,
    WindowGeometryMixin,
)

# ---------------------------------------------------------------------------
# Provider pricing info
# ---------------------------------------------------------------------------

_PROVIDER_INFO = {
    "openrouter": "Aggregates multiple providers via OpenRouter API",
    "anthropic": "Default pricing: $3.00/M input \u00b7 $15.00/M output",
    "openai": "Default pricing: $5.00/M input \u00b7 $15.00/M output",
    "deepseek": "Cost varies — see DeepSeek pricing page",
    "ollama": "Cost: Free (local inference)",
}

_PROVIDER_MODELS = {
    "openrouter": [
        "anthropic/claude-4.5-sonnet",
        "anthropic/claude-opus-4-1",
        "openai/gpt-4o",
        "deepseek/deepseek-chat-v4",
        "deepseek/deepseek-r1",
    ],
    "anthropic": [
        "claude-sonnet-4-6",
        "claude-opus-4-1",
        "claude-haiku-3-5",
    ],
    "openai": [
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4.1",
    ],
    "deepseek": [
        "deepseek-chat",
        "deepseek-reasoner",
    ],
}

# ---------------------------------------------------------------------------
# Secret field widget
# ---------------------------------------------------------------------------

class SecretFieldWidget(QWidget):
    """
    A compound widget for secret (API key) fields.

    Displays: [ ••••••••••••••last4 ]  [Show 10s]  [Edit]

    - Show: toggles plain-text reveal for 10 seconds then auto-masks.
    - Edit: opens an inline edit mode with a QLineEdit (password echo).
      Saving an unchanged masked value is a no-op (sentinel detection
      handled by SettingsService).
    """

    def __init__(self, key: str, service: SettingsService, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._key = key
        self._service = service
        self._edit_mode = False
        self._show_timer: Optional[QTimer] = None

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        # Display label (masked)
        self._display_label = QLabel()
        self._display_label.setFont(create_font(10))
        self._display_label.setStyleSheet(
            f"color: {COLORS['text_secondary']}; font-family: monospace;"
        )
        self._display_label.setMinimumWidth(260)
        layout.addWidget(self._display_label, stretch=1)

        # Edit field (hidden by default)
        self._edit_field = QLineEdit()
        self._edit_field.setEchoMode(QLineEdit.Password)
        self._edit_field.setPlaceholderText("Enter new value…")
        self._edit_field.setStyleSheet(get_input_field_stylesheet())
        self._edit_field.setFont(create_font(10))
        self._edit_field.setMinimumWidth(260)
        self._edit_field.hide()
        layout.addWidget(self._edit_field, stretch=1)

        # Show button
        self._show_btn = QPushButton("Show 10s")
        self._show_btn.setFont(create_font(9))
        self._show_btn.setStyleSheet(get_secondary_button_stylesheet())
        self._show_btn.setToolTip("Reveal this secret value in plain text for 10 seconds, then auto-mask")
        # BTCAAAAA-87: setMinimumWidth instead of setFixedWidth so button can
        # grow with content / DPI scaling rather than being clipped.
        self._show_btn.setMinimumWidth(80)
        self._show_btn.clicked.connect(self._on_show)
        layout.addWidget(self._show_btn)

        # Edit / Cancel button
        self._edit_btn = QPushButton("Edit")
        self._edit_btn.setFont(create_font(9))
        self._edit_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self._edit_btn.setToolTip("Enter edit mode to change this secret value — leave blank to keep existing")
        # BTCAAAAA-87: setMinimumWidth instead of setFixedWidth.
        self._edit_btn.setMinimumWidth(60)
        self._edit_btn.clicked.connect(self._on_edit_toggle)
        layout.addWidget(self._edit_btn)

        self._refresh_display()

    # ------------------------------------------------------------------

    def _refresh_display(self) -> None:
        try:
            masked = self._service.get_masked(self._key)
        except PermissionError:
            # Admin-only field accessed before auth — show locked indicator.
            # This is safe: the widget is inside the admin tab which is hidden
            # until PIN is verified.
            self._display_label.setText("(locked — admin access required)")
            self._display_label.setStyleSheet(
                f"color: {COLORS['text_muted']}; font-family: monospace;"
            )
            return
        if masked:
            self._display_label.setText(masked)
        else:
            self._display_label.setText("(not set)")
            self._display_label.setStyleSheet(
                f"color: {COLORS['text_muted']}; font-family: monospace;"
            )

    def _on_show(self) -> None:
        """Reveal plaintext for 10 seconds."""
        if self._edit_mode:
            return
        value = self._service.get(self._key)
        if not value:
            return
        self._display_label.setText(value)
        self._show_btn.setEnabled(False)
        if self._show_timer:
            self._show_timer.stop()
        self._show_timer = QTimer(self)
        self._show_timer.setSingleShot(True)
        self._show_timer.timeout.connect(self._auto_mask)
        self._show_timer.start(10_000)

    def _auto_mask(self) -> None:
        self._refresh_display()
        self._show_btn.setEnabled(True)
        if self._show_timer:
            self._show_timer = None

    def _on_edit_toggle(self) -> None:
        if not self._edit_mode:
            self._enter_edit_mode()
        else:
            self._exit_edit_mode()

    def _enter_edit_mode(self) -> None:
        self._edit_mode = True
        self._display_label.hide()
        self._show_btn.hide()
        self._edit_field.clear()
        self._edit_field.show()
        self._edit_field.setFocus()
        self._edit_btn.setText("Cancel")
        self._edit_btn.setStyleSheet(get_danger_button_stylesheet())

    def _exit_edit_mode(self) -> None:
        self._edit_mode = False
        self._edit_field.clear()
        self._edit_field.hide()
        self._display_label.show()
        self._show_btn.show()
        self._edit_btn.setText("Edit")
        self._edit_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self._refresh_display()

    # ------------------------------------------------------------------
    # Public interface

    def get_value(self) -> str:
        """
        Return the current value for this field.

        - If in edit mode and the user typed something: return the typed text.
        - Otherwise: return the masked sentinel so SettingsService skips it.
        """
        if self._edit_mode and self._edit_field.text().strip():
            return self._edit_field.text()
        # Return all-bullets sentinel — SettingsService will skip
        return "••••"

    def clear_edit(self) -> None:
        """Called after save — leave edit mode and re-mask."""
        if self._edit_mode:
            self._exit_edit_mode()
        self._refresh_display()


# ---------------------------------------------------------------------------
# Admin PIN dialog
# ---------------------------------------------------------------------------

class AdminPinDialog(QDialog):
    """
    PIN entry dialog for admin authentication or first-run PIN setup.

    Authentication mode (setup_mode=False, service provided):
    - Validates the PIN against SettingsService.elevate_to_admin().
    - Accepts (Accepted result) only on a correct PIN.
    - After 3 consecutive failures the dialog locks for 30 seconds.
    - A visible countdown label shows remaining seconds.
    - Input fields and the OK button are disabled during lockout.
    - Failure count resets when lockout expires or dialog closes.

    Setup mode (setup_mode=True):
    - No service needed; no lockout — user is creating the PIN fresh.
    - Dialog accepts with the entered PIN/confirm values for the caller
      to process.
    """

    _MAX_FAILURES: int = 3
    _LOCKOUT_SECONDS: int = 30

    def __init__(
        self,
        setup_mode: bool = False,
        service: Optional["SettingsService"] = None,
        parent: Optional[QWidget] = None,
    ) -> None:
        # Defect 5: Create as independent top-level window so dragging does not
        # move the Strategy Browser.  Qt.Tool keeps it always-on-top of the app
        # without parenting it into the main-window widget tree.
        super().__init__(None, Qt.Tool)
        self.setObjectName("admin_pin_dialog")
        self._setup_mode = setup_mode
        self._service = service  # Only used in auth mode
        self.setWindowTitle("Admin Authentication" if not setup_mode else "Set Admin PIN")
        self.setModal(True)
        # BTCAAAAA-87: Use layout-driven sizing — setMinimumWidth as a floor
        # only; let Qt measure the layout for actual width and height.
        # setup_mode adds a Confirm PIN field so needs a taller floor.
        # BTCAAAAA-91: Raised minimum width from 360 → 440 so the full title
        # "Admin Authentication", instruction text, PIN input, and both
        # "Cancel" / "Authenticate" buttons are visible without clipping.
        # BTCAAAAA-202: Lockout countdown label adds height — raise auth floor.
        min_h = 220 if setup_mode else 230
        self.setMinimumWidth(440)
        self.setMinimumHeight(min_h)
        self.setStyleSheet(get_main_stylesheet())

        # Brute-force lockout state (auth mode only)
        self._fail_count: int = 0
        self._lockout_remaining: int = 0
        self._lockout_timer: Optional[QTimer] = None

        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(24, 24, 24, 16)

        if setup_mode:
            msg = QLabel("No admin PIN set. Create one to enable admin access.")
        else:
            msg = QLabel("Enter your admin PIN to access restricted settings.")
        msg.setFont(create_font(10))
        msg.setStyleSheet(get_label_style("secondary"))
        msg.setWordWrap(True)
        layout.addWidget(msg)

        self._pin_field = QLineEdit()
        self._pin_field.setObjectName("pin_input")
        self._pin_field.setEchoMode(QLineEdit.Password)
        self._pin_field.setPlaceholderText("PIN…")
        self._pin_field.setStyleSheet(get_input_field_stylesheet())
        self._pin_field.setFont(create_font(10))
        layout.addWidget(self._pin_field)

        if setup_mode:
            self._confirm_field: Optional[QLineEdit] = QLineEdit()
            self._confirm_field.setEchoMode(QLineEdit.Password)
            self._confirm_field.setPlaceholderText("Confirm PIN…")
            self._confirm_field.setStyleSheet(get_input_field_stylesheet())
            self._confirm_field.setFont(create_font(10))
            self._confirm_field.returnPressed.connect(self.accept)
            layout.addWidget(self._confirm_field)
        else:
            self._confirm_field = None

        # Lockout countdown label (hidden until lockout activates; auth mode only)
        self._lockout_label = QLabel("")
        self._lockout_label.setFont(create_font(9))
        self._lockout_label.setStyleSheet(get_label_style("error"))
        self._lockout_label.setAlignment(Qt.AlignCenter)
        self._lockout_label.hide()
        layout.addWidget(self._lockout_label)

        buttons = QDialogButtonBox(
            QDialogButtonBox.Ok | QDialogButtonBox.Cancel, Qt.Horizontal
        )
        self._ok_button = buttons.button(QDialogButtonBox.Ok)
        self._ok_button.setText("Authenticate" if not setup_mode else "Set PIN")
        if setup_mode:
            # Setup mode: OK accepts directly (no lockout or validation here).
            self._pin_field.returnPressed.connect(self.accept)
            buttons.accepted.connect(self.accept)
            buttons.rejected.connect(self.reject)
        else:
            # Auth mode: wire OK and Return key to _attempt_auth; do NOT connect
            # buttons.accepted so it stays silent.  Cancel still rejects.
            # Disconnect the default QDialogButtonBox OK→accepted internal link
            # by not using accepted at all and blocking the OK click directly.
            self._ok_button.clicked.disconnect()
            self._ok_button.clicked.connect(self._attempt_auth)
            self._pin_field.returnPressed.connect(self._attempt_auth)
            buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        # BTCAAAAA-87: Let Qt size the window to fit the layout; the minimum
        # size set above acts as a floor, not the final size.
        QTimer.singleShot(0, self.adjustSize)

    # ------------------------------------------------------------------
    # Brute-force lockout (auth mode only)
    # ------------------------------------------------------------------

    def _attempt_auth(self) -> None:
        """
        Validate the entered PIN via SettingsService.elevate_to_admin().

        - On success: accepts the dialog (QDialog.Accepted).
        - On failure: increments the failure counter; after _MAX_FAILURES
          consecutive failures, locks the dialog for _LOCKOUT_SECONDS.
        - During lockout: guard against keyboard shortcuts bypassing the
          disabled OK button.
        """
        if self._lockout_remaining > 0:
            return  # Lockout active — do nothing (OK should already be disabled)

        if self._service is None:
            # Safety: no service in auth mode — reject to prevent bypass.
            self.reject()
            return

        pin = self._pin_field.text()
        if self._service.elevate_to_admin(pin):
            self.accept()
        else:
            self._fail_count += 1
            self._pin_field.clear()
            if self._fail_count >= self._MAX_FAILURES:
                self._start_lockout()

    def _start_lockout(self) -> None:
        """Disable input and start the countdown timer."""
        self._lockout_remaining = self._LOCKOUT_SECONDS
        self._pin_field.setEnabled(False)
        self._ok_button.setEnabled(False)
        self._lockout_label.setText(
            f"Too many incorrect attempts. Try again in {self._lockout_remaining}s."
        )
        self._lockout_label.show()
        QTimer.singleShot(0, self.adjustSize)

        self._lockout_timer = QTimer(self)
        self._lockout_timer.setInterval(1000)
        self._lockout_timer.timeout.connect(self._on_lockout_tick)
        self._lockout_timer.start()

    def _on_lockout_tick(self) -> None:
        """Decrement countdown; unlock when it reaches zero."""
        self._lockout_remaining -= 1
        if self._lockout_remaining <= 0:
            self._end_lockout()
        else:
            self._lockout_label.setText(
                f"Too many incorrect attempts. Try again in {self._lockout_remaining}s."
            )

    def _end_lockout(self) -> None:
        """Re-enable input after the lockout period expires."""
        if self._lockout_timer is not None:
            self._lockout_timer.stop()
            self._lockout_timer = None
        self._fail_count = 0
        self._lockout_remaining = 0
        self._pin_field.setEnabled(True)
        self._ok_button.setEnabled(True)
        self._lockout_label.hide()
        self._lockout_label.setText("")
        self._pin_field.setFocus()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        """Stop the lockout timer cleanly when the dialog is closed."""
        if self._lockout_timer is not None:
            self._lockout_timer.stop()
            self._lockout_timer = None
        super().closeEvent(event)

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_pin(self) -> str:
        return self._pin_field.text()

    def get_confirm_pin(self) -> str:
        if self._confirm_field:
            return self._confirm_field.text()
        return ""


# ---------------------------------------------------------------------------
# Settings Dialog
# ---------------------------------------------------------------------------

class SettingsDialog(WindowGeometryMixin, QDialog):
    """
    Main Settings dialog opened via Tools → Settings...

    Tab layout:
      - "API Keys"     — always visible, secret API key fields with Show/Edit
      - "Preferences"  — always visible, non-secret user preferences
      - "Admin"        — HIDDEN until PIN verified; shown/hidden on role change
    """

    GEOMETRY_SETTINGS_KEY = "settingsDialog"
    GEOMETRY_DEFAULT_SIZE = (800, 600)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        # Defect 5: Use Qt.Window (not Qt.Tool/Qt.Dialog) so the Settings
        # window is an independent top-level window — dragging it does NOT
        # move the Strategy Builder.
        # BTCAAAAA-240: Qt.Window gives a full OS title bar that includes a
        # working maximize button.  Qt.WindowMaximizeButtonHint is added
        # explicitly for platforms that require it.  We deliberately omit any
        # setFixedSize / setMaximumSize call so the window is freely resizable.
        super().__init__(
            None,
            Qt.Window | Qt.WindowMaximizeButtonHint | Qt.WindowMinimizeButtonHint | Qt.WindowCloseButtonHint,
        )
        self.setObjectName("settings_dialog")
        self.setWindowTitle("Settings")
        self.setModal(True)
        # BTCAAAAA-87: Replace fixed pixel size with layout-driven sizing.
        # setMinimumWidth/Height are floors only; adjustSize() (called after
        # _build_ui populates all tabs) lets Qt expand to fit the content,
        # preventing horizontal scrollbars and clipped banners/buttons.
        # BTCAAAAA-90: Raised minimum width floor from 820 to 860px to ensure
        # the widest row ("OpenRouter AI Key: (not set) | Show 10s | Edit")
        # fits with comfortable padding at default size.
        # BTCAAAAA-240: Do NOT call setMaximumSize — leave the upper bound
        # unconstrained so the window can maximise to fill the screen.
        self.setMinimumWidth(860)
        self.setMinimumHeight(600)
        self.setStyleSheet(get_main_stylesheet())

        self._service = SettingsService()

        # Will hold all secret widgets for value retrieval on save
        self._secret_widgets: dict[str, SecretFieldWidget] = {}
        # Plain text fields (non-secret)
        self._plain_fields: dict[str, QLineEdit] = {}
        # Combo box fields (model dropdowns with curated lists)
        self._combo_fields: dict[str, QComboBox] = {}
        # Admin section tab widget reference for hide/show
        self._admin_tab_index: int = -1

        self._build_ui()
        self._check_env_permissions()
        # BTCAAAAA-87: Size the window to its content after layout is built.
        # The minimum sizes set above act as floors; adjustSize() lets Qt
        # compute the ideal size so content is never clipped.
        QTimer.singleShot(0, self.adjustSize)

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 12)
        root.setSpacing(12)

        # Title
        title = QLabel("Application Settings")
        title.setFont(create_font(14, bold=True))
        title.setStyleSheet(get_panel_title_stylesheet())
        root.addWidget(title)

        # Tab widget
        self._tabs = QTabWidget()
        self._tabs.setObjectName("settings_tabs")
        self._tabs.setFont(create_font(10))
        self._tabs.setStyleSheet(get_tab_widget_stylesheet())
        # BTCAAAAA-92: resize the window when the user switches tabs so that
        # the Admin tab (which has more content than API Keys / Preferences)
        # never clips its contents.  adjustSize() asks Qt to recompute the
        # ideal window size from the current sizeHint of visible widgets.
        self._tabs.currentChanged.connect(lambda _index: QTimer.singleShot(0, self.adjustSize))
        root.addWidget(self._tabs, stretch=1)

        # Tab 1: API Keys (user-editable secret fields)
        self._tabs.addTab(self._build_api_keys_tab(), "API Keys")

        # Tab 2: Preferences (non-secret user settings)
        self._tabs.addTab(self._build_preferences_tab(), "Preferences")

        # Tab 3: Admin (hidden until PIN)
        admin_tab = self._build_admin_tab()
        self._tabs.addTab(admin_tab, "Admin")
        self._admin_tab_index = 2  # Tab 0=API Keys, 1=Preferences, 2=Admin
        self._tabs.setTabVisible(self._admin_tab_index, False)

        # Admin access row
        admin_row = self._build_admin_access_row()
        root.addWidget(admin_row)

        # Separator
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"background-color: {COLORS['border']}; max-height: 1px;")
        root.addWidget(sep)

        # Bottom buttons
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(8)
        btn_layout.addStretch()

        cancel_btn = QPushButton("Cancel")
        cancel_btn.setObjectName("cancel_btn")
        cancel_btn.setFont(create_font(10))
        cancel_btn.setStyleSheet(get_secondary_button_stylesheet())
        cancel_btn.setToolTip("Discard all changes and close Settings")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)

        save_btn = QPushButton("Save && Close")
        save_btn.setObjectName("save_btn")
        save_btn.setFont(create_font(10, bold=True))
        save_btn.setStyleSheet(get_primary_button_stylesheet())
        save_btn.setToolTip("Save all settings changes and close the dialog")
        save_btn.clicked.connect(self._on_save)
        btn_layout.addWidget(save_btn)

        root.addLayout(btn_layout)

        QTimer.singleShot(100, lambda: apply_hand_cursor_to_buttons(self))

    # ------------------------------------------------------------------

    def _build_api_keys_tab(self) -> QWidget:
        """User-visible API key settings — secret fields with Show/Edit."""
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        # BTCAAAAA-90: suppress horizontal scrollbar artifact — content areas
        # in this dialog must never show a horizontal scrollbar.
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setStyleSheet(get_transparent_scroll_area_stylesheet())

        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # --- API Keys group ---
        api_group = QGroupBox("API Keys")
        api_group.setFont(create_font(10, bold=True))
        api_form = QFormLayout(api_group)
        api_form.setSpacing(10)
        api_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        # OpenRouter API key
        self._secret_widgets["OPENROUTER_API_KEY"] = SecretFieldWidget(
            "OPENROUTER_API_KEY", self._service
        )
        api_form.addRow(self._make_label("OpenRouter AI Key:"), self._secret_widgets["OPENROUTER_API_KEY"])

        # LakeAPI key
        self._secret_widgets["LAKEAPI_KEY"] = SecretFieldWidget(
            "LAKEAPI_KEY", self._service
        )
        api_form.addRow(self._make_label("LakeAPI Key:"), self._secret_widgets["LAKEAPI_KEY"])

        # LakeAPI secret
        self._secret_widgets["LAKEAPI_SECRET"] = SecretFieldWidget(
            "LAKEAPI_SECRET", self._service
        )
        api_form.addRow(self._make_label("LakeAPI Secret:"), self._secret_widgets["LAKEAPI_SECRET"])

        layout.addWidget(api_group)
        layout.addStretch()
        scroll.setWidget(container)
        return scroll

    # ------------------------------------------------------------------

    def _build_preferences_tab(self) -> QWidget:
        """User-editable preferences — non-secret settings.

        Groups:
          - AI Configuration
          - Performance & Resources
          - Data & API
          - Alerts & Logging
          - UI Preferences
        """
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        # BTCAAAAA-90: suppress horizontal scrollbar artifact.
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setStyleSheet(get_transparent_scroll_area_stylesheet())

        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # ----------------------------------------------------------------
        # Group: AI Configuration
        # ----------------------------------------------------------------
        layout.addWidget(self._build_ai_config_group())

        # ----------------------------------------------------------------
        # Group: Performance & Resources
        # ----------------------------------------------------------------
        perf_group = QGroupBox("Performance & Resources")
        perf_group.setFont(create_font(10, bold=True))
        perf_form = QFormLayout(perf_group)
        perf_form.setSpacing(10)
        perf_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("MULTICORE_WORKERS", "CPU Workers:",
             "auto (leave empty)", "Number of CPU cores for parallel processing — leave empty to auto-detect"),
            ("MEMORY_LIMIT_GB", "Memory Limit (GB):",
             "16", "Memory limit per worker in GB (e.g. 16)"),
            ("CPU_CORES_MIN", "CPU Cores Min:",
             "1", "Minimum number of CPU cores to allocate"),
            ("CPU_CORES_MAX", "CPU Cores Max:",
             "auto", "Maximum CPU cores — enter a number or 'auto'"),
            ("CPU_AFFINITY_MODE", "CPU Affinity Mode:",
             "automatic", "CPU affinity strategy: automatic or manual"),
            ("MEMORY_CHART_HISTORY", "Chart History (points):",
             "60", "Number of data points to keep in memory for charts"),
            ("UPDATE_INTERVAL", "Update Interval (ms):",
             "1000", "General UI update interval in milliseconds"),
        ]:
            self._plain_fields[key] = QLineEdit()
            self._plain_fields[key].setText(
                self._service.get_with_default(key, placeholder)
            )
            self._plain_fields[key].setPlaceholderText(placeholder)
            self._plain_fields[key].setStyleSheet(get_input_field_stylesheet())
            self._plain_fields[key].setFont(create_font(10))
            self._plain_fields[key].setToolTip(tooltip)
            perf_form.addRow(self._make_label(label), self._plain_fields[key])

        layout.addWidget(perf_group)

        # ----------------------------------------------------------------
        # Group: Data & API
        # ----------------------------------------------------------------
        data_group = QGroupBox("Data & API")
        data_group.setFont(create_font(10, bold=True))
        data_form = QFormLayout(data_group)
        data_form.setSpacing(10)
        data_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("LAKEAPI_REGION", "LakeAPI Region:",
             "eu-west-1", "LakeAPI S3 region for market data downloads"),
            ("LAKEAPI_LIMIT_GB", "Monthly Transfer Limit (GB):",
             "300", "Monthly bandwidth cap for LakeAPI downloads in GB"),
        ]:
            self._plain_fields[key] = QLineEdit()
            self._plain_fields[key].setText(
                self._service.get_with_default(key, placeholder)
            )
            self._plain_fields[key].setPlaceholderText(placeholder)
            self._plain_fields[key].setStyleSheet(get_input_field_stylesheet())
            self._plain_fields[key].setFont(create_font(10))
            self._plain_fields[key].setToolTip(tooltip)
            data_form.addRow(self._make_label(label), self._plain_fields[key])

        layout.addWidget(data_group)

        # ----------------------------------------------------------------
        # Group: Alerts & Logging
        # ----------------------------------------------------------------
        alert_group = QGroupBox("Alerts & Logging")
        alert_group.setFont(create_font(10, bold=True))
        alert_form = QFormLayout(alert_group)
        alert_form.setSpacing(10)
        alert_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self._plain_fields["ENABLE_ALERTS"] = QLineEdit()
        self._plain_fields["ENABLE_ALERTS"].setText(
            self._service.get_with_default("ENABLE_ALERTS", "false")
        )
        self._plain_fields["ENABLE_ALERTS"].setPlaceholderText("true / false")
        self._plain_fields["ENABLE_ALERTS"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["ENABLE_ALERTS"].setFont(create_font(10))
        self._plain_fields["ENABLE_ALERTS"].setToolTip(
            "Enable usage alerts: true or false"
        )
        alert_form.addRow(self._make_label("Enable Alerts:"), self._plain_fields["ENABLE_ALERTS"])

        self._plain_fields["LOG_LEVEL"] = QLineEdit()
        self._plain_fields["LOG_LEVEL"].setText(
            self._service.get_with_default("LOG_LEVEL", "INFO")
        )
        self._plain_fields["LOG_LEVEL"].setPlaceholderText("DEBUG / INFO / WARNING / ERROR / CRITICAL")
        self._plain_fields["LOG_LEVEL"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["LOG_LEVEL"].setFont(create_font(10))
        self._plain_fields["LOG_LEVEL"].setToolTip(
            "Application log verbosity: DEBUG, INFO, WARNING, ERROR, or CRITICAL"
        )
        alert_form.addRow(self._make_label("Log Level:"), self._plain_fields["LOG_LEVEL"])

        self._plain_fields["ALERT_EMAIL"] = QLineEdit()
        self._plain_fields["ALERT_EMAIL"].setText(
            self._service.get_with_default("ALERT_EMAIL", "")
        )
        self._plain_fields["ALERT_EMAIL"].setPlaceholderText("your@email.com (optional)")
        self._plain_fields["ALERT_EMAIL"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["ALERT_EMAIL"].setFont(create_font(10))
        self._plain_fields["ALERT_EMAIL"].setToolTip("Email address for usage and alert notifications")
        alert_form.addRow(self._make_label("Alert Email:"), self._plain_fields["ALERT_EMAIL"])

        layout.addWidget(alert_group)

        # ----------------------------------------------------------------
        # Group: UI Preferences
        # ----------------------------------------------------------------
        ui_group = QGroupBox("UI Preferences")
        ui_group.setFont(create_font(10, bold=True))
        ui_form = QFormLayout(ui_group)
        ui_form.setSpacing(10)
        ui_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self._plain_fields["DARK_THEME_ENABLED"] = QLineEdit()
        self._plain_fields["DARK_THEME_ENABLED"].setText(
            self._service.get_with_default("DARK_THEME_ENABLED", "true")
        )
        self._plain_fields["DARK_THEME_ENABLED"].setPlaceholderText("true / false")
        self._plain_fields["DARK_THEME_ENABLED"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["DARK_THEME_ENABLED"].setFont(create_font(10))
        self._plain_fields["DARK_THEME_ENABLED"].setToolTip(
            "Enable dark theme: true or false (restart required)"
        )
        ui_form.addRow(self._make_label("Dark Theme:"), self._plain_fields["DARK_THEME_ENABLED"])

        self._plain_fields["UI_THEME"] = QLineEdit()
        self._plain_fields["UI_THEME"].setText(
            self._service.get_with_default("UI_THEME", "dark")
        )
        self._plain_fields["UI_THEME"].setPlaceholderText("dark / light")
        self._plain_fields["UI_THEME"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["UI_THEME"].setFont(create_font(10))
        self._plain_fields["UI_THEME"].setToolTip("UI theme identifier: dark or light (restart required)")
        ui_form.addRow(self._make_label("UI Theme:"), self._plain_fields["UI_THEME"])

        layout.addWidget(ui_group)

        layout.addStretch()
        scroll.setWidget(container)
        return scroll

    # ------------------------------------------------------------------
    # AI Configuration group
    # ------------------------------------------------------------------

    def _build_ai_config_group(self) -> QGroupBox:
        ai_group = QGroupBox("AI Configuration")
        ai_group.setFont(create_font(10, bold=True))
        form = QFormLayout(ai_group)
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        # Provider selector (order must match _provider_stack indices)
        provider_names = ["openrouter", "anthropic", "openai", "deepseek", "ollama"]
        self._provider_combo = QComboBox()
        self._provider_combo.addItems(provider_names)
        current = self._service.get_with_default("AI_PROVIDER", "openrouter")
        idx = self._provider_combo.findText(current)
        if idx >= 0:
            self._provider_combo.setCurrentIndex(idx)
        self._provider_combo.setFont(create_font(10))
        form.addRow(self._make_label("AI Provider:"), self._provider_combo)
        self._combo_fields["AI_PROVIDER"] = self._provider_combo

        # Provider-specific fields stacked by index matching combo order
        self._provider_stack = QStackedWidget()
        self._provider_stack.setStyleSheet("background: transparent;")

        # Helper: build editable model combo with curated list
        def _model_combo(
            key: str, default: str, models: list[str], tooltip: str,
        ) -> QComboBox:
            combo = QComboBox()
            combo.setEditable(True)
            combo.addItems(models)
            current_val = self._service.get_with_default(key, default)
            ci = combo.findText(current_val)
            if ci >= 0:
                combo.setCurrentIndex(ci)
            else:
                combo.setEditText(current_val)
            combo.setFont(create_font(10))
            combo.setToolTip(tooltip)
            self._combo_fields[key] = combo
            return combo

        # -- OpenRouter page (index 0) --
        or_page = QWidget()
        or_form = QFormLayout(or_page)
        or_form.setSpacing(8)
        or_form.setContentsMargins(0, 0, 0, 0)
        or_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        sec = SecretFieldWidget("OPENROUTER_API_KEY", self._service)
        self._secret_widgets["OPENROUTER_API_KEY"] = sec
        or_form.addRow(self._make_label("API Key:"), sec)

        or_form.addRow(
            self._make_label("Model:"),
            _model_combo(
                "AI_MODEL", "anthropic/claude-4.5-sonnet",
                _PROVIDER_MODELS["openrouter"],
                "OpenRouter model identifier with provider prefix (e.g. anthropic/claude-4.5-sonnet)",
            ),
        )
        self._provider_stack.addWidget(or_page)

        # -- Anthropic page (index 1) --
        anth_page = QWidget()
        anth_form = QFormLayout(anth_page)
        anth_form.setSpacing(8)
        anth_form.setContentsMargins(0, 0, 0, 0)
        anth_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        sec = SecretFieldWidget("ANTHROPIC_API_KEY", self._service)
        self._secret_widgets["ANTHROPIC_API_KEY"] = sec
        anth_form.addRow(self._make_label("API Key:"), sec)

        anth_form.addRow(
            self._make_label("Model:"),
            _model_combo(
                "ANTHROPIC_MODEL", "claude-sonnet-4-6",
                _PROVIDER_MODELS["anthropic"],
                "Anthropic Claude model ID (e.g. claude-sonnet-4-6, claude-opus-4-1)",
            ),
        )
        self._provider_stack.addWidget(anth_page)

        # -- OpenAI page (index 2) --
        oai_page = QWidget()
        oai_form = QFormLayout(oai_page)
        oai_form.setSpacing(8)
        oai_form.setContentsMargins(0, 0, 0, 0)
        oai_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        sec = SecretFieldWidget("OPENAI_API_KEY", self._service)
        self._secret_widgets["OPENAI_API_KEY"] = sec
        oai_form.addRow(self._make_label("API Key:"), sec)

        oai_form.addRow(
            self._make_label("Model:"),
            _model_combo(
                "OPENAI_MODEL", "gpt-4o",
                _PROVIDER_MODELS["openai"],
                "OpenAI model ID (e.g. gpt-4o, gpt-4o-mini)",
            ),
        )
        self._provider_stack.addWidget(oai_page)

        # -- DeepSeek page (index 3) --
        ds_page = QWidget()
        ds_form = QFormLayout(ds_page)
        ds_form.setSpacing(8)
        ds_form.setContentsMargins(0, 0, 0, 0)
        ds_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        sec = SecretFieldWidget("DEEPSEEK_API_KEY", self._service)
        self._secret_widgets["DEEPSEEK_API_KEY"] = sec
        ds_form.addRow(self._make_label("API Key:"), sec)

        self._plain_fields["DEEPSEEK_BASE_URL"] = QLineEdit()
        self._plain_fields["DEEPSEEK_BASE_URL"].setText(
            self._service.get_with_default("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        )
        self._plain_fields["DEEPSEEK_BASE_URL"].setPlaceholderText("https://api.deepseek.com")
        self._plain_fields["DEEPSEEK_BASE_URL"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["DEEPSEEK_BASE_URL"].setFont(create_font(10))
        self._plain_fields["DEEPSEEK_BASE_URL"].setToolTip(
            "DeepSeek API base URL (e.g. https://api.deepseek.com)"
        )
        ds_form.addRow(self._make_label("Base URL:"), self._plain_fields["DEEPSEEK_BASE_URL"])

        ds_form.addRow(
            self._make_label("Model:"),
            _model_combo(
                "DEEPSEEK_MODEL", "deepseek-chat",
                _PROVIDER_MODELS["deepseek"],
                "DeepSeek model ID (e.g. deepseek-chat, deepseek-reasoner)",
            ),
        )
        self._provider_stack.addWidget(ds_page)

        # -- Ollama page (index 4) -- freeform text for local models
        ol_page = QWidget()
        ol_form = QFormLayout(ol_page)
        ol_form.setSpacing(8)
        ol_form.setContentsMargins(0, 0, 0, 0)
        ol_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self._plain_fields["OLLAMA_BASE_URL"] = QLineEdit()
        self._plain_fields["OLLAMA_BASE_URL"].setText(
            self._service.get_with_default("OLLAMA_BASE_URL", "http://localhost:11434")
        )
        self._plain_fields["OLLAMA_BASE_URL"].setPlaceholderText("http://localhost:11434")
        self._plain_fields["OLLAMA_BASE_URL"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["OLLAMA_BASE_URL"].setFont(create_font(10))
        self._plain_fields["OLLAMA_BASE_URL"].setToolTip(
            "Ollama API base URL (e.g. http://localhost:11434)"
        )
        ol_form.addRow(self._make_label("Base URL:"), self._plain_fields["OLLAMA_BASE_URL"])

        self._plain_fields["OLLAMA_MODEL"] = QLineEdit()
        self._plain_fields["OLLAMA_MODEL"].setText(
            self._service.get_with_default("OLLAMA_MODEL", "llama3")
        )
        self._plain_fields["OLLAMA_MODEL"].setPlaceholderText("llama3")
        self._plain_fields["OLLAMA_MODEL"].setStyleSheet(get_input_field_stylesheet())
        self._plain_fields["OLLAMA_MODEL"].setFont(create_font(10))
        self._plain_fields["OLLAMA_MODEL"].setToolTip(
            "Ollama model name (e.g. llama3, mistral, codellama)"
        )
        ol_form.addRow(self._make_label("Model:"), self._plain_fields["OLLAMA_MODEL"])

        self._provider_stack.addWidget(ol_page)

        form.addRow("", self._provider_stack)

        # Provider info label
        self._provider_info_label = QLabel()
        self._provider_info_label.setFont(create_font(9))
        self._provider_info_label.setStyleSheet(get_label_style("muted"))
        form.addRow("", self._provider_info_label)

        # Connect provider change handler and set initial info
        self._provider_combo.currentIndexChanged.connect(self._on_provider_changed)
        self._update_provider_info()

        return ai_group

    # ------------------------------------------------------------------

    def _on_provider_changed(self, index: int) -> None:
        self._provider_stack.setCurrentIndex(index)
        self._update_provider_info()

    def _update_provider_info(self) -> None:
        provider = self._provider_combo.currentText()
        self._provider_info_label.setText(_PROVIDER_INFO.get(provider, ""))

    # ------------------------------------------------------------------

    def _build_admin_tab(self) -> QWidget:
        """Admin-only settings: DB, risk, strategy, training, resource thresholds.

        IMPORTANT: this method must NOT call self._service.get() or
        get_with_default() for any admin-only key.  Those calls go through
        _check_access() which raises PermissionError for non-admin sessions
        and would crash the dialog on open (BTCAAAAA-82).

        Fields are initialised with static placeholder defaults here and
        populated with live values only after PIN authentication succeeds
        in _populate_admin_fields().
        """
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        # BTCAAAAA-90: suppress horizontal scrollbar artifact.
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setStyleSheet(get_transparent_scroll_area_stylesheet())

        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # Admin badge
        badge = QLabel("ADMIN ACCESS REQUIRED — Changes here affect database and system behaviour.")
        badge.setFont(create_font(9, bold=True))
        badge.setStyleSheet(
            f"color: {COLORS['warning']}; "
            f"background-color: {COLORS['bg_medium']}; "
            f"border: 1px solid {COLORS['warning']}; "
            f"border-radius: 4px; padding: 6px 10px;"
        )
        badge.setWordWrap(True)
        layout.addWidget(badge)

        # ----------------------------------------------------------------
        # Helper: build a plain field row (uses static placeholder, populated later)
        # ----------------------------------------------------------------
        def _admin_field(key: str, placeholder: str, tooltip: str = "") -> QLineEdit:
            field = QLineEdit()
            field.setText(placeholder)
            field.setPlaceholderText(placeholder)
            field.setStyleSheet(get_input_field_stylesheet())
            field.setFont(create_font(10))
            if tooltip:
                field.setToolTip(tooltip)
            self._plain_fields[key] = field
            return field

        # ----------------------------------------------------------------
        # Group: Database Connection
        # ----------------------------------------------------------------
        db_group = QGroupBox("Database Connection")
        db_group.setFont(create_font(10, bold=True))
        db_form = QFormLayout(db_group)
        db_form.setSpacing(10)
        db_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("POSTGRES_HOST", "Host:", "localhost", "PostgreSQL server hostname or IP"),
            ("POSTGRES_PORT", "Port:", "5432", "PostgreSQL port (default 5432)"),
            ("POSTGRES_DB", "Database:", "optimizer_v3", "Database name"),
            ("POSTGRES_USER", "User:", "optimizer_admin", "Database user account"),
        ]:
            db_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        # DB password (secret field)
        self._secret_widgets["POSTGRES_PASSWORD"] = SecretFieldWidget(
            "POSTGRES_PASSWORD", self._service
        )
        db_form.addRow(self._make_label("Password:"), self._secret_widgets["POSTGRES_PASSWORD"])

        layout.addWidget(db_group)

        # ----------------------------------------------------------------
        # Group: DB Connection Pool
        # ----------------------------------------------------------------
        pool_group = QGroupBox("DB Connection Pool")
        pool_group.setFont(create_font(10, bold=True))
        pool_form = QFormLayout(pool_group)
        pool_form.setSpacing(10)
        pool_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("POSTGRES_POOL_SIZE", "Pool Size:", "10",
             "Number of persistent connections in the connection pool"),
            ("POSTGRES_MAX_OVERFLOW", "Max Overflow:", "20",
             "Maximum extra connections allowed above pool_size"),
            ("POSTGRES_POOL_TIMEOUT", "Pool Timeout (s):", "30",
             "Seconds to wait for a connection before raising an error"),
            ("POSTGRES_POOL_RECYCLE", "Pool Recycle (s):", "3600",
             "Seconds after which connections are recycled (prevents stale connections)"),
        ]:
            pool_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(pool_group)

        # ----------------------------------------------------------------
        # Group: DB SSL
        # ----------------------------------------------------------------
        ssl_group = QGroupBox("DB SSL")
        ssl_group.setFont(create_font(10, bold=True))
        ssl_form = QFormLayout(ssl_group)
        ssl_form.setSpacing(10)
        ssl_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        ssl_form.addRow(
            self._make_label("SSL Enabled:"),
            _admin_field("POSTGRES_SSL", "false",
                         "Enable SSL for PostgreSQL connections: true or false"),
        )

        # SSL cert/key are secret — stored in keyring
        for key, label, tooltip in [
            ("POSTGRES_SSL_CERT_PATH", "SSL Cert Path:",
             "Path to PEM-encoded SSL certificate file"),
            ("POSTGRES_SSL_KEY_PATH", "SSL Key Path:",
             "Path to PEM-encoded SSL private key file"),
        ]:
            self._secret_widgets[key] = SecretFieldWidget(key, self._service)
            ssl_form.addRow(self._make_label(label), self._secret_widgets[key])

        layout.addWidget(ssl_group)

        # ----------------------------------------------------------------
        # Group: DB Monitoring
        # ----------------------------------------------------------------
        mon_group = QGroupBox("DB Monitoring")
        mon_group.setFont(create_font(10, bold=True))
        mon_form = QFormLayout(mon_group)
        mon_form.setSpacing(10)
        mon_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("POSTGRES_LOG_MIN_DURATION", "Log Min Duration (ms):", "1000",
             "Log queries that take longer than this many milliseconds (0 = log all)"),
            ("POSTGRES_LOG_CONNECTIONS", "Log Connections:", "false",
             "Log each new connection: true or false"),
            ("POSTGRES_LOG_DISCONNECTIONS", "Log Disconnections:", "false",
             "Log each connection close: true or false"),
        ]:
            mon_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(mon_group)

        # ----------------------------------------------------------------
        # Group: Backup
        # ----------------------------------------------------------------
        bak_group = QGroupBox("Backup")
        bak_group.setFont(create_font(10, bold=True))
        bak_form = QFormLayout(bak_group)
        bak_form.setSpacing(10)
        bak_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("POSTGRES_BACKUP_PATH", "Backup Path:", "",
             "Directory path where backups are written"),
            ("POSTGRES_BACKUP_RETENTION_DAYS", "Retention (days):", "30",
             "Number of days to keep backup files"),
            ("POSTGRES_BACKUP_COMPRESSION", "Compression:", "true",
             "Compress backup files: true or false"),
        ]:
            bak_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(bak_group)

        # ----------------------------------------------------------------
        # Group: Risk Management
        # ----------------------------------------------------------------
        risk_group = QGroupBox("Risk Management")
        risk_group.setFont(create_font(10, bold=True))
        risk_form = QFormLayout(risk_group)
        risk_form.setSpacing(10)
        risk_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("RISK_MIN_REWARD_RATIO", "Min Reward Ratio:", "2.0",
             "Minimum acceptable risk:reward ratio for a trade"),
            ("RISK_PERCENT", "Risk Percent:", "1.0",
             "Percentage of capital risked per trade"),
            ("RISK_MAX_LEVERAGE", "Max Leverage:", "1.0",
             "Maximum leverage multiplier (1.0 = no leverage)"),
            ("RISK_MIN_CONFLUENCE", "Min Confluence:", "2",
             "Minimum number of confirming signals required"),
            ("RISK_MAX_BARS_HELD", "Max Bars Held:", "20",
             "Maximum number of bars a position can be held"),
            ("RISK_MAX_DRAWDOWN", "Max Drawdown:", "0.02",
             "Maximum acceptable portfolio drawdown (e.g. 0.02 = 2%)"),
            ("RISK_MIN_WIN_RATE", "Min Win Rate:", "0.55",
             "Minimum required win rate (e.g. 0.55 = 55%)"),
            ("RISK_MIN_PROFIT_FACTOR", "Min Profit Factor:", "1.5",
             "Minimum acceptable profit factor"),
            ("RISK_MAX_CORRELATION", "Max Correlation:", "0.7",
             "Maximum allowed correlation between positions"),
            ("RISK_MAX_EXPOSURE", "Max Exposure:", "0.1",
             "Maximum total exposure as fraction of capital"),
            ("EMERGENCY_SL_ENABLED", "Emergency SL Enabled:", "true",
             "Activate emergency stop-loss: true or false"),
            ("EMERGENCY_SL_THRESHOLD", "Emergency SL Threshold:", "3.0",
             "ATR multiplier for emergency stop-loss trigger"),
            ("EMERGENCY_SL_VOLATILITY_LOOKBACK", "ESL Vol Lookback:", "14",
             "Lookback periods for emergency SL volatility calculation"),
            ("EMERGENCY_SL_VOLATILITY_MULTIPLIER", "ESL Vol Multiplier:", "2.0",
             "Volatility multiplier for emergency SL width"),
            ("TP_FIBONACCI_LEVELS", "TP Fibonacci Levels:", "[1.618, 2.618, 3.618]",
             "Take-profit Fibonacci extension levels (JSON list)"),
            ("TP_FIBONACCI_ADJUSTMENT_THRESHOLD", "TP Fib Adjustment Threshold:", "0.01",
             "Minimum distance for Fibonacci TP adjustment"),
            ("TP_HYBRID_ATR_MULTIPLIER", "TP Hybrid ATR Multiplier:", "2.0",
             "ATR multiplier for hybrid take-profit"),
            ("TP_HYBRID_MIN_DISTANCE", "TP Hybrid Min Distance:", "0.005",
             "Minimum distance for hybrid take-profit"),
            ("TP_FIXED_DISTANCES", "TP Fixed Distances:", "[0.01, 0.02, 0.03]",
             "Fixed take-profit distance levels (JSON list)"),
            ("SL_ADAPTIVE_ATR_PERIOD", "SL Adaptive ATR Period:", "14",
             "ATR period for adaptive stop-loss"),
            ("SL_ADAPTIVE_ATR_MULTIPLIER", "SL Adaptive ATR Multiplier:", "2.0",
             "ATR multiplier for adaptive stop-loss"),
            ("SL_ADAPTIVE_MIN_DISTANCE", "SL Adaptive Min Distance:", "0.005",
             "Minimum distance for adaptive stop-loss"),
            ("SL_STATIC_DISTANCE", "SL Static Distance:", "0.01",
             "Fixed stop-loss distance as fraction of price"),
        ]:
            risk_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(risk_group)

        # ----------------------------------------------------------------
        # Group: Strategy Configuration (Optimization Ranges)
        # ----------------------------------------------------------------
        opt_group = QGroupBox("Strategy Configuration — Optimization Ranges")
        opt_group.setFont(create_font(10, bold=True))
        opt_form = QFormLayout(opt_group)
        opt_form.setSpacing(10)
        opt_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("OPTIMIZATION_RISK_REWARD_MIN", "Risk/Reward Min:", "1.5",
             "Minimum risk:reward ratio to test during optimization"),
            ("OPTIMIZATION_RISK_REWARD_MAX", "Risk/Reward Max:", "3.0",
             "Maximum risk:reward ratio to test during optimization"),
            ("OPTIMIZATION_RISK_PERCENT_MIN", "Risk % Min:", "0.5",
             "Minimum risk percent per trade during optimization"),
            ("OPTIMIZATION_RISK_PERCENT_MAX", "Risk % Max:", "2.0",
             "Maximum risk percent per trade during optimization"),
            ("OPTIMIZATION_CONFLUENCE_MIN", "Confluence Min:", "1",
             "Minimum confluence level in optimization sweep"),
            ("OPTIMIZATION_CONFLUENCE_MAX", "Confluence Max:", "3",
             "Maximum confluence level in optimization sweep"),
            ("OPTIMIZATION_BARS_HELD_MIN", "Bars Held Min:", "10",
             "Minimum bars held in optimization sweep"),
            ("OPTIMIZATION_BARS_HELD_MAX", "Bars Held Max:", "30",
             "Maximum bars held in optimization sweep"),
            ("OPTIMIZATION_VOLATILITY_MULTIPLIER_MIN", "Vol Multiplier Min:", "1.5",
             "Minimum volatility multiplier in optimization sweep"),
            ("OPTIMIZATION_VOLATILITY_MULTIPLIER_MAX", "Vol Multiplier Max:", "2.5",
             "Maximum volatility multiplier in optimization sweep"),
            ("OPTIMIZATION_SL_DISTANCE_MIN", "SL Distance Min:", "0.003",
             "Minimum stop-loss distance in optimization sweep"),
            ("OPTIMIZATION_SL_DISTANCE_MAX", "SL Distance Max:", "0.025",
             "Maximum stop-loss distance in optimization sweep"),
        ]:
            opt_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(opt_group)

        # ----------------------------------------------------------------
        # Group: Strategy Configuration (Metrics)
        # ----------------------------------------------------------------
        metrics_group = QGroupBox("Strategy Configuration — Performance Metrics")
        metrics_group.setFont(create_font(10, bold=True))
        metrics_form = QFormLayout(metrics_group)
        metrics_form.setSpacing(10)
        metrics_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("METRICS_SHARPE_WINDOW", "Sharpe Window:", "252",
             "Rolling window for Sharpe ratio calculation (trading days)"),
            ("METRICS_SORTINO_WINDOW", "Sortino Window:", "252",
             "Rolling window for Sortino ratio calculation"),
            ("METRICS_CALMAR_WINDOW", "Calmar Window:", "252",
             "Rolling window for Calmar ratio calculation"),
            ("METRICS_MIN_TRADES", "Min Trades:", "30",
             "Minimum number of trades required before metrics are computed"),
            ("METRICS_CONFIDENCE_LEVEL", "Confidence Level:", "0.95",
             "Confidence level for statistical metric calculations"),
            ("RISK_VAR_CONFIDENCE", "VaR Confidence:", "0.99",
             "Confidence level for Value-at-Risk"),
            ("RISK_VAR_WINDOW", "VaR Window:", "10",
             "Rolling window for VaR calculation (days)"),
            ("RISK_ES_CONFIDENCE", "ES Confidence:", "0.975",
             "Confidence level for Expected Shortfall"),
            ("RISK_MONTE_CARLO_SIMS", "Monte Carlo Sims:", "10000",
             "Number of Monte Carlo simulations for risk metrics"),
            ("RISK_DRAWDOWN_WINDOW", "Drawdown Window:", "252",
             "Rolling window for drawdown metrics"),
            ("RISK_CORRELATION_WINDOW", "Correlation Window:", "60",
             "Rolling window for correlation calculation"),
            ("TRADE_MIN_SAMPLE_SIZE", "Trade Min Sample:", "50",
             "Minimum trades required for trade analysis"),
            ("TRADE_PATTERN_CONFIDENCE", "Pattern Confidence:", "0.95",
             "Confidence threshold for trade pattern recognition"),
            ("TRADE_CLUSTER_THRESHOLD", "Cluster Threshold:", "0.5",
             "Distance threshold for trade clustering"),
            ("TRADE_QUALITY_WINDOW", "Trade Quality Window:", "30",
             "Rolling window for trade quality scoring"),
            ("TRADE_SLIPPAGE_THRESHOLD", "Slippage Threshold:", "0.001",
             "Threshold beyond which slippage is flagged"),
            ("TRADE_COMMISSION_IMPACT_THRESHOLD", "Commission Impact:", "0.002",
             "Threshold for flagging high commission impact"),
            ("CAPITAL_EFFICIENCY_TARGET", "Capital Efficiency Target:", "0.8",
             "Target capital utilization efficiency (0-1)"),
            ("CAPITAL_FREE_MARGIN_TARGET", "Free Margin Target:", "0.3",
             "Target free margin as fraction of capital (0-1)"),
            ("CAPITAL_MAX_USAGE_LIMIT", "Capital Max Usage:", "0.9",
             "Hard limit on capital usage as fraction (0-1)"),
            ("CAPITAL_TURNOVER_TARGET", "Capital Turnover Target:", "12",
             "Target number of portfolio turnovers per year"),
            ("CAPITAL_CURVE_SMOOTHNESS", "Curve Smoothness:", "0.7",
             "Target equity curve smoothness score (0-1)"),
            ("WEIGHT_SHARPE_RATIO", "Weight Sharpe:", "0.20",
             "Scoring weight for Sharpe ratio (weights sum to 1.0)"),
            ("WEIGHT_SORTINO_RATIO", "Weight Sortino:", "0.15", "Scoring weight for Sortino ratio"),
            ("WEIGHT_CALMAR_RATIO", "Weight Calmar:", "0.15", "Scoring weight for Calmar ratio"),
            ("WEIGHT_WIN_RATE", "Weight Win Rate:", "0.10", "Scoring weight for win rate"),
            ("WEIGHT_PROFIT_FACTOR", "Weight Profit Factor:", "0.10", "Scoring weight for profit factor"),
            ("WEIGHT_MAX_DRAWDOWN", "Weight Max Drawdown:", "0.10", "Scoring weight for max drawdown"),
            ("WEIGHT_CAPITAL_EFFICIENCY", "Weight Capital Eff.:", "0.10",
             "Scoring weight for capital efficiency"),
            ("WEIGHT_TRADE_QUALITY", "Weight Trade Quality:", "0.10",
             "Scoring weight for trade quality"),
        ]:
            metrics_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(metrics_group)

        # ----------------------------------------------------------------
        # Group: State Management
        # ----------------------------------------------------------------
        state_group = QGroupBox("State Management")
        state_group.setFont(create_font(10, bold=True))
        state_form = QFormLayout(state_group)
        state_form.setSpacing(10)
        state_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("STATE_SAVE_INTERVAL", "Save Interval (s):", "300",
             "Interval in seconds between automatic state saves"),
            ("STATE_MAX_HISTORY", "Max History:", "100",
             "Maximum number of historical state snapshots to retain"),
            ("STATE_COMPRESSION", "Compression:", "true",
             "Compress saved state files: true or false"),
            ("STATE_BACKUP_COUNT", "Backup Count:", "3",
             "Number of rolling state backups to keep"),
            ("STATE_VALIDATION_LEVEL", "Validation Level:", "strict",
             "State validation strictness: strict, normal, or off"),
        ]:
            state_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(state_group)

        # ----------------------------------------------------------------
        # Group: Training System
        # ----------------------------------------------------------------
        train_group = QGroupBox("Training System")
        train_group.setFont(create_font(10, bold=True))
        train_form = QFormLayout(train_group)
        train_form.setSpacing(10)
        train_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("TRAINING_MAX_LOOKBACK", "Max Lookback (days):", "180",
             "Maximum lookback period for training data in days"),
            ("TRAINING_MIN_SIGNALS", "Min Signals:", "50",
             "Minimum number of signals required for a training run"),
            ("TRAINING_MAX_TIMEFRAMES", "Max Timeframes:", "5",
             "Maximum number of timeframes used in training"),
            ("TRAINING_BATCH_SIZE", "Batch Size:", "1000",
             "Number of samples per training batch"),
            ("TRAINING_PARALLEL_BLOCKS", "Parallel Blocks:", "4",
             "Number of strategy blocks processed in parallel during training"),
        ]:
            train_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(train_group)

        # ----------------------------------------------------------------
        # Group: Resource Thresholds
        # ----------------------------------------------------------------
        res_group = QGroupBox("Resource Thresholds")
        res_group.setFont(create_font(10, bold=True))
        res_form = QFormLayout(res_group)
        res_form.setSpacing(10)
        res_form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        for key, label, placeholder, tooltip in [
            ("RESOURCE_CHECK_INTERVAL", "Check Interval (s):", "60",
             "Interval in seconds between resource usage checks"),
            ("RESOURCE_WARNING_THRESHOLD", "Warning Threshold (%):", "80",
             "CPU/memory usage percentage that triggers a warning"),
            ("RESOURCE_CRITICAL_THRESHOLD", "Critical Threshold (%):", "90",
             "CPU/memory usage percentage that triggers critical action"),
            ("RESOURCE_AUTO_CLEANUP", "Auto Cleanup:", "true",
             "Automatically free resources when critical threshold is hit: true or false"),
            ("RESOURCE_HISTORY_LENGTH", "History Length:", "1440",
             "Number of resource usage samples to keep in history"),
        ]:
            res_form.addRow(self._make_label(label), _admin_field(key, placeholder, tooltip))

        layout.addWidget(res_group)

        # ----------------------------------------------------------------
        # Group: Change Admin PIN
        # ----------------------------------------------------------------
        pin_group = QGroupBox("Admin PIN")
        pin_group.setFont(create_font(10, bold=True))
        pin_layout = QVBoxLayout(pin_group)
        pin_layout.setSpacing(8)

        pin_note = QLabel(
            "Change the admin PIN that gates access to this section. "
            "Keep it safe — there is no recovery path."
        )
        pin_note.setFont(create_font(9))
        pin_note.setStyleSheet(get_label_style("muted"))
        pin_note.setWordWrap(True)
        pin_layout.addWidget(pin_note)

        change_pin_btn = QPushButton("Change Admin PIN…")
        change_pin_btn.setFont(create_font(9))
        change_pin_btn.setStyleSheet(get_secondary_button_stylesheet())
        change_pin_btn.setToolTip("Change the admin PIN that gates access to restricted settings")
        # BTCAAAAA-87: setMinimumWidth instead of setFixedWidth so button
        # can grow with content / DPI scaling.
        change_pin_btn.setMinimumWidth(200)
        change_pin_btn.clicked.connect(self._on_change_pin)
        pin_layout.addWidget(change_pin_btn)

        layout.addWidget(pin_group)

        layout.addStretch()
        scroll.setWidget(container)
        return scroll

    # ------------------------------------------------------------------

    def _build_admin_access_row(self) -> QWidget:
        """Row at the bottom of the dialog for admin auth / lock controls."""
        row = QWidget()
        row.setStyleSheet(f"background-color: {COLORS['bg_medium']}; border-radius: 4px;")
        layout = QHBoxLayout(row)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.setSpacing(10)

        self._admin_status_label = QLabel("Admin access: locked")
        self._admin_status_label.setFont(create_font(9))
        self._admin_status_label.setStyleSheet(get_label_style("muted"))
        layout.addWidget(self._admin_status_label)

        layout.addStretch()

        # Defect 3: Use clear, unambiguous labels; setMinimumWidth prevents
        # truncation while allowing the button to grow with content.
        self._admin_auth_btn = QPushButton("Unlock Admin")
        self._admin_auth_btn.setObjectName("admin_auth_btn")
        self._admin_auth_btn.setFont(create_font(9))
        self._admin_auth_btn.setStyleSheet(get_primary_button_stylesheet(compact=True))
        self._admin_auth_btn.setMinimumWidth(130)
        self._admin_auth_btn.setToolTip("Enter your admin PIN to unlock restricted settings")
        self._admin_auth_btn.clicked.connect(self._on_admin_auth)
        layout.addWidget(self._admin_auth_btn)

        self._admin_lock_btn = QPushButton("Lock Admin")
        self._admin_lock_btn.setObjectName("admin_lock_btn")
        self._admin_lock_btn.setFont(create_font(9))
        self._admin_lock_btn.setStyleSheet(get_danger_button_stylesheet())
        self._admin_lock_btn.setMinimumWidth(110)
        self._admin_lock_btn.setToolTip("Lock admin access — restricted settings will be hidden again")
        self._admin_lock_btn.hide()
        self._admin_lock_btn.clicked.connect(self._on_admin_lock)
        layout.addWidget(self._admin_lock_btn)

        return row

    # ------------------------------------------------------------------
    # Admin gate logic
    # ------------------------------------------------------------------

    def _on_admin_auth(self) -> None:
        """Prompt for PIN and unlock admin tab if correct."""
        if not self._service.has_admin_pin():
            # First-time setup — no PIN exists yet.
            dlg = AdminPinDialog(setup_mode=True, parent=self)
            if dlg.exec_() != QDialog.Accepted:
                return
            pin = dlg.get_pin()
            confirm = dlg.get_confirm_pin()
            if not pin:
                QMessageBox.warning(self, "PIN Required", "PIN cannot be empty.")
                return
            if pin != confirm:
                QMessageBox.warning(self, "PIN Mismatch", "The two PIN values do not match.")
                return
            try:
                # Grant admin temporarily so set_admin_pin first-run path is allowed.
                # elevate_to_admin_first_run() is only valid before any PIN is set.
                self._service.elevate_to_admin_first_run()
                self._service.set_admin_pin(pin)
                self._reveal_admin_tab()
            except Exception as e:
                self._service.drop_admin()
                QMessageBox.critical(self, "Error", f"Failed to set PIN:\n{e}")
        else:
            # Auth mode — pass service so AdminPinDialog validates internally
            # and applies brute-force lockout after repeated failures.
            dlg = AdminPinDialog(setup_mode=False, service=self._service, parent=self)
            if dlg.exec_() == QDialog.Accepted:
                # Dialog already called elevate_to_admin() on success.
                self._reveal_admin_tab()

    def _on_admin_lock(self) -> None:
        self._service.drop_admin()
        self._conceal_admin_tab()

    def _populate_admin_fields(self) -> None:
        """Load live admin setting values into the admin tab fields.

        Must only be called after PIN authentication (role == ADMIN).
        Using the service before auth raises PermissionError for admin keys.
        """
        from src.strategy_builder.ui.settings_service import ADMIN_DEFAULTS
        for key, default in ADMIN_DEFAULTS.items():
            if key in self._plain_fields:
                try:
                    value = self._service.get_with_default(key, default)
                except PermissionError:
                    value = default
                self._plain_fields[key].setText(value)

        # Refresh all admin secret widgets now that admin role is active
        for key in ("POSTGRES_PASSWORD", "POSTGRES_SSL_CERT_PATH", "POSTGRES_SSL_KEY_PATH"):
            if key in self._secret_widgets:
                self._secret_widgets[key]._refresh_display()

    def _reveal_admin_tab(self) -> None:
        # Populate admin fields with live values now that role is elevated.
        self._populate_admin_fields()
        self._tabs.setTabVisible(self._admin_tab_index, True)
        # BTCAAAAA-92: switch to the Admin tab and let adjustSize expand the
        # window to accommodate its extra content (badge, DB fields, etc.).
        self._tabs.setCurrentIndex(self._admin_tab_index)
        QTimer.singleShot(0, self.adjustSize)
        self._admin_status_label.setText("Admin access: unlocked")
        self._admin_status_label.setStyleSheet(
            f"color: {COLORS['warning']}; font-weight: bold;"
        )
        self._admin_auth_btn.hide()
        self._admin_lock_btn.show()

    def _conceal_admin_tab(self) -> None:
        # Switch away from admin tab before hiding it
        if self._tabs.currentIndex() == self._admin_tab_index:
            self._tabs.setCurrentIndex(0)
        self._tabs.setTabVisible(self._admin_tab_index, False)
        self._admin_status_label.setText("Admin access: locked")
        self._admin_status_label.setStyleSheet(get_label_style("muted"))
        self._admin_auth_btn.show()
        self._admin_lock_btn.hide()

    # ------------------------------------------------------------------
    # Save logic
    # ------------------------------------------------------------------

    def _on_save(self) -> None:
        """Collect all field values and persist via SettingsService."""
        errors: list[str] = []

        # Collect user values
        user_values: dict[str, str] = {}
        for key, widget in self._secret_widgets.items():
            if key in ("POSTGRES_PASSWORD", "POSTGRES_SSL_CERT_PATH", "POSTGRES_SSL_KEY_PATH"):
                # Skip admin-only secrets if not admin
                if not self._service.is_admin():
                    continue
            user_values[key] = widget.get_value()

        for key, field in self._plain_fields.items():
            user_values[key] = field.text().strip()

        for key, combo in self._combo_fields.items():
            user_values[key] = combo.currentText().strip()

        # User-editable keys (non-admin)
        _user_keys = {
            "OPENROUTER_API_KEY", "LAKEAPI_KEY", "LAKEAPI_SECRET",
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
            "AI_PROVIDER", "ANTHROPIC_MODEL", "OPENAI_MODEL",
            "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
            "OLLAMA_BASE_URL", "OLLAMA_MODEL",
            "AI_MODEL", "ALERT_EMAIL",
            "LAKEAPI_REGION", "LAKEAPI_LIMIT_GB",
            "MULTICORE_WORKERS", "MEMORY_LIMIT_GB",
            "CPU_CORES_MIN", "CPU_CORES_MAX", "CPU_AFFINITY_MODE",
            "MEMORY_CHART_HISTORY", "UPDATE_INTERVAL",
            "ENABLE_ALERTS", "LOG_LEVEL",
            "DARK_THEME_ENABLED", "UI_THEME",
        }

        # Persist user settings
        try:
            self._service.save_user_settings(
                {k: v for k, v in user_values.items() if k in _user_keys}
            )
        except Exception as e:
            errors.append(f"User settings: {e}")

        # Persist admin settings (only if admin role active)
        if self._service.is_admin():
            admin_values = {
                k: v for k, v in user_values.items()
                if k not in _user_keys
            }
            try:
                self._service.save_admin_settings(admin_values)
            except PermissionError:
                pass  # Should not happen — admin is active
            except Exception as e:
                errors.append(f"Admin settings: {e}")

        if errors:
            QMessageBox.warning(
                self,
                "Save Errors",
                "Some settings could not be saved:\n\n" + "\n".join(errors)
            )
        else:
            # Reset all secret widgets to masked display, then close the dialog.
            for widget in self._secret_widgets.values():
                widget.clear_edit()
            self.accept()  # BTCAAAAA-98: close dialog on successful save

    # ------------------------------------------------------------------
    # Change PIN
    # ------------------------------------------------------------------

    def _on_change_pin(self) -> None:
        if not self._service.is_admin():
            QMessageBox.warning(self, "Admin Required", "Unlock admin access first.")
            return
        dlg = AdminPinDialog(setup_mode=True, parent=self)
        dlg.setWindowTitle("Change Admin PIN")
        if dlg.exec_() != QDialog.Accepted:
            return
        pin = dlg.get_pin()
        confirm = dlg.get_confirm_pin()
        if not pin:
            QMessageBox.warning(self, "PIN Required", "PIN cannot be empty.")
            return
        if pin != confirm:
            QMessageBox.warning(self, "PIN Mismatch", "The two PIN values do not match.")
            return
        try:
            self._service.set_admin_pin(pin)
            QMessageBox.information(self, "PIN Changed", "Admin PIN updated successfully.")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to change PIN:\n{e}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _make_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setFont(create_font(10))
        lbl.setStyleSheet(get_label_style("default"))
        return lbl

    def _check_env_permissions(self) -> None:
        """Silently enforce 600 on .env on dialog open."""
        SettingsService._enforce_env_permissions()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))
        self._restore_window_geometry(event)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)
