"""
QComboBox White Separator Bar Fix

Universal fix for Qt's persistent white separator bars in dropdown menus.
This applies comprehensive styling at both CSS and widget configuration levels.

Author: Strategy Builder Team  
Date: 2026-01-18
"""

from PyQt5.QtWidgets import QComboBox, QStyledItemDelegate
from PyQt5.QtCore import Qt, QSize
from PyQt5.QtGui import QPainter


class NoSeparatorDelegate(QStyledItemDelegate):
    """
    Custom item delegate that prevents separator rendering between items.
    
    This is required because Qt's default rendering includes separator lines
    that cannot be removed via CSS alone on some platforms.
    """
    
    def sizeHint(self, option, index):
        """Override size hint to ensure no extra spacing."""
        size = super().sizeHint(option, index)
        # Force exact height with no spacing
        return QSize(size.width(), size.height())
    
    def paint(self, painter, option, index):
        """Override paint to remove any separator rendering."""
        # Use default painting but with modified option
        painter.save()
        
        # Ensure no decoration
        option.decorationSize = QSize(0, 0)
        
        # Paint the item
        super().paint(painter, option, index)
        
        painter.restore()


def fix_combobox_white_bars(combo_box: QComboBox):
    """
    Apply comprehensive fix to remove white separator bars from QComboBox dropdown.
    
    This applies multiple fixes at different levels:
    1. Widget-level spacing configuration
    2. Disable alternating colors (main cause of white bars)
    3. Custom item delegate to prevent separator rendering
    4. Additional view properties
    5. Fix popup container frame
    
    Args:
        combo_box: The QComboBox to fix
    """
    if not combo_box:
        return
    
    # Get the dropdown view
    view = combo_box.view()
    
    # CRITICAL: Get the parent container (popup frame) and remove its frame
    popup = view.parent()
    if popup:
        popup.setWindowFlags(popup.windowFlags() | Qt.FramelessWindowHint)
        popup.setAttribute(Qt.WA_TranslucentBackground, False)
    
    # CRITICAL: Disable alternating row colors (main cause of white bars)
    view.setAlternatingRowColors(False)
    
    # LEVEL 1: Widget Configuration
    view.setSpacing(0)
    view.setUniformItemSizes(True)
    
    # LEVEL 2: Additional View Properties
    view.setFrameShape(0)  # No frame
    view.setLineWidth(0)   # No line width
    view.setMidLineWidth(0)  # No mid-line width
    
    # LEVEL 3: Custom Item Delegate (prevents separator rendering)
    delegate = NoSeparatorDelegate(combo_box)
    view.setItemDelegate(delegate)
    
    # LEVEL 4: Style properties - REMOVE ALL BORDERS INCLUDING POPUP FRAME
    view.setStyleSheet("""
        QListView {
            background-color: #2A2F3A;
            alternate-background-color: #2A2F3A;
            border: 0px;
            outline: 0;
            show-decoration-selected: 0;
            margin: 0px;
            padding: 0px;
        }
        QListView::item {
            background-color: #2A2F3A;
            color: #E8EAED;
            padding: 6px 8px;
            margin: 0px;
            border: 0px;
            height: 28px;
        }
        QListView::item:alternate {
            background-color: #2A2F3A;
        }
        QListView::item:selected {
            background-color: #2070FF;
            color: #FFFFFF;
        }
        QListView::item:hover {
            background-color: #2070FF;
            color: #FFFFFF;
        }
    """)
    
    # LEVEL 5: Style the popup container itself
    if popup:
        popup.setStyleSheet("""
            QFrame {
                background-color: #2A2F3A;
                border: 0px;
                margin: 0px;
                padding: 0px;
            }
        """)


def apply_to_all_comboboxes(widget):
    """
    Recursively find and fix all QComboBox widgets in a container.
    
    Args:
        widget: Parent widget to search
    """
    # Fix if this is a combo box
    if isinstance(widget, QComboBox):
        fix_combobox_white_bars(widget)
    
    # Recursively check children
    for child in widget.findChildren(QComboBox):
        fix_combobox_white_bars(child)
