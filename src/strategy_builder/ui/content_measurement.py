"""
Content Measurement Utility
Smart Resizable Details Panel - Phase 1

Measures QLabel content height and detects text overflow.
Used for dynamic content-aware layout management.
"""

from PyQt5.QtWidgets import QLabel
from PyQt5.QtGui import QTextDocument


class ContentMeasurement:
    """
    Measures QLabel content height and detects overflow
    
    Uses QTextDocument to accurately measure HTML/plain text content
    accounting for word wrap, margins, and formatting.
    """
    
    @staticmethod
    def get_content_height(label: QLabel) -> int:
        """
        Calculate actual height needed to display all text
        
        Args:
            label: QLabel widget to measure
        
        Returns:
            int: Height in pixels required for all content
        
        Example:
            >>> label = QLabel("Long text " * 100)
            >>> label.setWordWrap(True)
            >>> label.setFixedWidth(200)
            >>> height = ContentMeasurement.get_content_height(label)
            >>> print(f"Content needs {height}px height")
        """
        # Use QTextDocument to measure HTML content
        doc = QTextDocument()
        
        # Set HTML content (handles both plain text and HTML)
        doc.setHtml(label.text())
        
        # Set text width to match label width (for word wrap)
        doc.setTextWidth(label.width())
        
        # Get document size (includes all content)
        size = doc.size()
        
        # Add label's content margins
        margins = label.contentsMargins()
        total_height = int(size.height()) + margins.top() + margins.bottom()
        
        return total_height
    
    @staticmethod
    def is_text_cutoff(label: QLabel) -> bool:
        """
        Detect if text is being cut off (content > allocated space)
        
        Args:
            label: QLabel widget to check
        
        Returns:
            bool: True if text is cut off, False if all text fits
        
        Example:
            >>> label = QLabel("Very long text that doesn't fit")
            >>> label.setFixedHeight(50)  # Force cutoff
            >>> if ContentMeasurement.is_text_cutoff(label):
            ...     print("Text is being cut off!")
        """
        content_height = ContentMeasurement.get_content_height(label)
        allocated_height = label.height()
        
        # Account for small rounding errors (1px tolerance)
        return content_height > (allocated_height + 1)
    
    @staticmethod
    def calculate_overflow_pixels(label: QLabel) -> int:
        """
        Calculate how many pixels of content are being cut off
        
        Args:
            label: QLabel widget to measure
        
        Returns:
            int: Pixels of overflow (0 if all content fits)
        
        Example:
            >>> label = QLabel("Long text " * 50)
            >>> label.setFixedHeight(100)
            >>> overflow = ContentMeasurement.calculate_overflow_pixels(label)
            >>> print(f"{overflow}px of text is hidden")
        """
        content_height = ContentMeasurement.get_content_height(label)
        allocated_height = label.height()
        
        # Return overflow amount (0 if fits)
        overflow = max(0, content_height - allocated_height)
        
        return overflow
    
    @staticmethod
    def get_ideal_height(label: QLabel) -> int:
        """
        Get ideal height for label to display all content without cutoff
        
        Args:
            label: QLabel widget
        
        Returns:
            int: Ideal height in pixels
        
        Example:
            >>> label = QLabel("Some text")
            >>> ideal = ContentMeasurement.get_ideal_height(label)
            >>> label.setFixedHeight(ideal)  # Perfect fit
        """
        return ContentMeasurement.get_content_height(label)
