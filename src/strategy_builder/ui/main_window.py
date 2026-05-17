from PyQt6.QtWidgets import QMainWindow, QMenuBar, QMenu, QAction
from src.strategy_builder.ui.styles import (
    WINDOW_STYLE,
    MENU_STYLE,
    create_font,
    WindowGeometryMixin,
)
from src.strategy_builder.ui.system_config import SystemConfigWindow

class MainWindow(WindowGeometryMixin, QMainWindow):
    """Main application window with consistent styling"""

    GEOMETRY_SETTINGS_KEY = "mainWindowLegacy"
    GEOMETRY_DEFAULT_SIZE = (1200, 800)

    def __init__(self):
        super().__init__()
        self.setObjectName("main_window")
        self.setWindowTitle("Strategy Builder")
        self.setStyleSheet(WINDOW_STYLE)
        self.setup_menu()
        
        # Store child windows
        self.system_config_window = None
    
    def setup_menu(self):
        """Setup main menu bar"""
        menubar = QMenuBar()
        menubar.setNativeMenuBar(False)
        menubar.setStyleSheet(MENU_STYLE)
        menubar.setFont(create_font())
        
        # File menu
        file_menu = QMenu("File", self)
        file_menu.setStyleSheet(MENU_STYLE)
        file_menu.setFont(create_font())
        
        exit_action = QAction("Exit", self)
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)
        
        # Tools menu
        tools_menu = QMenu("Tools", self)
        tools_menu.setStyleSheet(MENU_STYLE)
        tools_menu.setFont(create_font())
        
        system_config_action = QAction("System Configuration", self)
        system_config_action.triggered.connect(self.show_system_config)
        tools_menu.addAction(system_config_action)
        
        # Add menus to menubar
        menubar.addMenu(file_menu)
        menubar.addMenu(tools_menu)
        
        self.setMenuBar(menubar)
    def showEvent(self, event):
        """Called when window is shown - restore geometry and apply hand cursors."""
        super().showEvent(event)
        self._restore_window_geometry(event)
        from PyQt5.QtCore import QTimer
        from .styles import apply_hand_cursor_to_buttons
        QTimer.singleShot(200, lambda: apply_hand_cursor_to_buttons(self))

    def closeEvent(self, event):
        """Save window geometry on close."""
        self._save_window_geometry()
        super().closeEvent(event)

    
    def show_system_config(self):
        """Show system configuration window"""
        if self.system_config_window is None:
            self.system_config_window = SystemConfigWindow()
        self.system_config_window.show()
        self.system_config_window.activateWindow()
