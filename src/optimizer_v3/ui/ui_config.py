"""
UI Configuration Loader for Optimizer v3

Loads UI theme and layout configuration from environment variables.
All UI components should use this configuration for consistent styling.

Author: Optimizer v3 Team
Date: 2026-01-20
Sprint: 1.4 (UI Integration)
"""

from dotenv import load_dotenv
import os
from typing import Dict, Any, Optional
from dataclasses import dataclass


@dataclass
class ThemeConfig:
    """Theme configuration"""
    mode: str
    font_family: str
    font_size_base: int
    font_size_small: int
    font_size_large: int
    font_weight_normal: int
    font_weight_bold: int


@dataclass
class WindowConfig:
    """Window configuration"""
    min_width: int
    min_height: int
    opacity: float
    title_height: int
    border_radius: int


@dataclass
class TabConfig:
    """Tab configuration"""
    height: int
    min_width: int
    max_width: int
    spacing: int
    border_radius: int


@dataclass
class PanelConfig:
    """Panel configuration"""
    margin: int
    padding: int
    border_radius: int
    shadow_blur: int
    shadow_color: str


@dataclass
class ControlConfig:
    """Control configuration"""
    button_height: int
    button_min_width: int
    button_padding: int
    button_border_radius: int
    button_font_size: int


@dataclass
class TableConfig:
    """Table configuration"""
    row_height: int
    header_height: int
    cell_padding: int
    alternating_colors: bool
    grid_color: str
    selection_color: str


@dataclass
class ChartConfig:
    """Chart configuration"""
    min_height: int
    padding: int
    axis_font_size: int
    legend_font_size: int
    line_width: int
    point_size: int


@dataclass
class ProgressConfig:
    """Progress bar configuration"""
    height: int
    border_radius: int
    animation_ms: int
    update_interval: int


@dataclass
class AnimationConfig:
    """Animation configuration"""
    duration: int
    easing: str
    hover: bool
    transition: bool


@dataclass
class ColorScheme:
    """Color scheme for light or dark theme"""
    primary: str
    secondary: str
    success: str
    warning: str
    error: str
    info: str
    background: str
    surface: str
    text: str
    border: str


@dataclass
class BreakpointsConfig:
    """Responsive breakpoints"""
    small: int
    medium: int
    large: int
    xl: int
    xxl: int


@dataclass
class IntervalsConfig:
    """Update intervals"""
    ui: int
    chart: int
    table: int
    animation: int


@dataclass
class PerformanceConfig:
    """Performance settings"""
    max_chart_points: int
    table_virtualization: bool
    lazy_loading: bool
    debounce_delay: int
    throttle_delay: int


class UIConfig:
    """
    Central UI configuration manager.
    
    Loads configuration from environment variables and provides
    typed access to all UI settings.
    """
    
    def __init__(self, env_path: Optional[str] = None):
        """
        Initialize UI configuration.
        
        Args:
            env_path: Optional path to .env file
        """
        if env_path:
            load_dotenv(env_path)
        else:
            load_dotenv()
        
        self._load_config()
    
    def _get_env(self, key: str, default: Any, cast_type: type = str) -> Any:
        """
        Get environment variable with type casting.
        
        Args:
            key: Environment variable key
            default: Default value if not found
            cast_type: Type to cast to
            
        Returns:
            Typed value from environment or default
        """
        value = os.getenv(key)
        if value is None:
            return default
        
        try:
            if cast_type == bool:
                return value.lower() in ('true', '1', 'yes', 'on')
            return cast_type(value)
        except (ValueError, TypeError):
            return default
    
    def _load_config(self) -> None:
        """Load all configuration from environment"""
        # Theme configuration
        self.theme = ThemeConfig(
            mode=self._get_env('UI_THEME', 'dark'),
            font_family=self._get_env('UI_FONT_FAMILY', 'Segoe UI'),
            font_size_base=self._get_env('UI_FONT_SIZE_BASE', 14, int),
            font_size_small=self._get_env('UI_FONT_SIZE_SMALL', 12, int),
            font_size_large=self._get_env('UI_FONT_SIZE_LARGE', 16, int),
            font_weight_normal=self._get_env('UI_FONT_WEIGHT_NORMAL', 400, int),
            font_weight_bold=self._get_env('UI_FONT_WEIGHT_BOLD', 600, int)
        )
        
        # Window configuration
        self.window = WindowConfig(
            min_width=self._get_env('WINDOW_MIN_WIDTH', 1280, int),
            min_height=self._get_env('WINDOW_MIN_HEIGHT', 800, int),
            opacity=self._get_env('WINDOW_OPACITY', 1.0, float),
            title_height=self._get_env('WINDOW_TITLE_HEIGHT', 32, int),
            border_radius=self._get_env('WINDOW_BORDER_RADIUS', 4, int)
        )
        
        # Tab configuration
        self.tab = TabConfig(
            height=self._get_env('TAB_HEIGHT', 32, int),
            min_width=self._get_env('TAB_MIN_WIDTH', 120, int),
            max_width=self._get_env('TAB_MAX_WIDTH', 200, int),
            spacing=self._get_env('TAB_SPACING', 2, int),
            border_radius=self._get_env('TAB_BORDER_RADIUS', 4, int)
        )
        
        # Panel configuration
        self.panel = PanelConfig(
            margin=self._get_env('PANEL_MARGIN', 8, int),
            padding=self._get_env('PANEL_PADDING', 16, int),
            border_radius=self._get_env('PANEL_BORDER_RADIUS', 4, int),
            shadow_blur=self._get_env('PANEL_SHADOW_BLUR', 10, int),
            shadow_color=self._get_env('PANEL_SHADOW_COLOR', '#00000020')
        )
        
        # Control configuration
        self.control = ControlConfig(
            button_height=self._get_env('BUTTON_HEIGHT', 32, int),
            button_min_width=self._get_env('BUTTON_MIN_WIDTH', 100, int),
            button_padding=self._get_env('BUTTON_PADDING', 16, int),
            button_border_radius=self._get_env('BUTTON_BORDER_RADIUS', 4, int),
            button_font_size=self._get_env('BUTTON_FONT_SIZE', 14, int)
        )
        
        # Table configuration
        self.table = TableConfig(
            row_height=self._get_env('TABLE_ROW_HEIGHT', 32, int),
            header_height=self._get_env('TABLE_HEADER_HEIGHT', 40, int),
            cell_padding=self._get_env('TABLE_CELL_PADDING', 8, int),
            alternating_colors=self._get_env('TABLE_ALTERNATING_COLORS', True, bool),
            grid_color=self._get_env('TABLE_GRID_COLOR', '#E0E0E0'),
            selection_color=self._get_env('TABLE_SELECTION_COLOR', '#007ACC40')
        )
        
        # Chart configuration
        self.chart = ChartConfig(
            min_height=self._get_env('CHART_MIN_HEIGHT', 300, int),
            padding=self._get_env('CHART_PADDING', 16, int),
            axis_font_size=self._get_env('CHART_AXIS_FONT_SIZE', 12, int),
            legend_font_size=self._get_env('CHART_LEGEND_FONT_SIZE', 12, int),
            line_width=self._get_env('CHART_LINE_WIDTH', 2, int),
            point_size=self._get_env('CHART_POINT_SIZE', 6, int)
        )
        
        # Progress configuration
        self.progress = ProgressConfig(
            height=self._get_env('PROGRESS_HEIGHT', 24, int),
            border_radius=self._get_env('PROGRESS_BORDER_RADIUS', 12, int),
            animation_ms=self._get_env('PROGRESS_ANIMATION_MS', 750, int),
            update_interval=self._get_env('PROGRESS_UPDATE_INTERVAL', 100, int)
        )
        
        # Animation configuration
        self.animation = AnimationConfig(
            duration=self._get_env('ANIMATION_DURATION', 200, int),
            easing=self._get_env('ANIMATION_EASING', 'easeInOutCubic'),
            hover=self._get_env('HOVER_ANIMATION', True, bool),
            transition=self._get_env('TRANSITION_ANIMATION', True, bool)
        )
        
        # Color schemes
        self.colors_light = ColorScheme(
            primary=self._get_env('COLOR_PRIMARY', '#007ACC'),
            secondary=self._get_env('COLOR_SECONDARY', '#6C757D'),
            success=self._get_env('COLOR_SUCCESS', '#28A745'),
            warning=self._get_env('COLOR_WARNING', '#FFC107'),
            error=self._get_env('COLOR_ERROR', '#DC3545'),
            info=self._get_env('COLOR_INFO', '#17A2B8'),
            background=self._get_env('COLOR_BACKGROUND', '#FFFFFF'),
            surface=self._get_env('COLOR_SURFACE', '#F8F9FA'),
            text=self._get_env('COLOR_TEXT', '#212529'),
            border=self._get_env('COLOR_BORDER', '#DEE2E6')
        )
        
        self.colors_dark = ColorScheme(
            primary=self._get_env('COLOR_DARK_PRIMARY', '#0098FF'),
            secondary=self._get_env('COLOR_DARK_SECONDARY', '#A1A9B0'),
            success=self._get_env('COLOR_DARK_SUCCESS', '#34D058'),
            warning=self._get_env('COLOR_DARK_WARNING', '#FFD700'),
            error=self._get_env('COLOR_DARK_ERROR', '#FF4D4D'),
            info=self._get_env('COLOR_DARK_INFO', '#58C7DB'),
            background=self._get_env('COLOR_DARK_BACKGROUND', '#1E1E1E'),
            surface=self._get_env('COLOR_DARK_SURFACE', '#252526'),
            text=self._get_env('COLOR_DARK_TEXT', '#CCCCCC'),
            border=self._get_env('COLOR_DARK_BORDER', '#404040')
        )
        
        # Breakpoints
        self.breakpoints = BreakpointsConfig(
            small=self._get_env('BREAKPOINT_SMALL', 640, int),
            medium=self._get_env('BREAKPOINT_MEDIUM', 768, int),
            large=self._get_env('BREAKPOINT_LARGE', 1024, int),
            xl=self._get_env('BREAKPOINT_XL', 1280, int),
            xxl=self._get_env('BREAKPOINT_XXL', 1536, int)
        )
        
        # Intervals
        self.intervals = IntervalsConfig(
            ui=self._get_env('UI_UPDATE_INTERVAL', 100, int),
            chart=self._get_env('CHART_UPDATE_INTERVAL', 1000, int),
            table=self._get_env('TABLE_UPDATE_INTERVAL', 500, int),
            animation=self._get_env('ANIMATION_UPDATE_INTERVAL', 16, int)
        )
        
        # Performance
        self.performance = PerformanceConfig(
            max_chart_points=self._get_env('MAX_CHART_POINTS', 1000, int),
            table_virtualization=self._get_env('TABLE_VIRTUALIZATION', True, bool),
            lazy_loading=self._get_env('LAZY_LOADING', True, bool),
            debounce_delay=self._get_env('DEBOUNCE_DELAY', 150, int),
            throttle_delay=self._get_env('THROTTLE_DELAY', 100, int)
        )
    
    @property
    def colors(self) -> ColorScheme:
        """
        Get current theme colors.
        
        Returns:
            Color scheme for active theme
        """
        return self.colors_dark if self.theme.mode == 'dark' else self.colors_light
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Export configuration as dictionary.
        
        Returns:
            Complete configuration dictionary
        """
        return {
            'theme': {
                'mode': self.theme.mode,
                'font': {
                    'family': self.theme.font_family,
                    'size_base': self.theme.font_size_base,
                    'size_small': self.theme.font_size_small,
                    'size_large': self.theme.font_size_large,
                    'weight_normal': self.theme.font_weight_normal,
                    'weight_bold': self.theme.font_weight_bold
                }
            },
            'window': {
                'min_width': self.window.min_width,
                'min_height': self.window.min_height,
                'opacity': self.window.opacity,
                'title_height': self.window.title_height,
                'border_radius': self.window.border_radius
            },
            'tab': {
                'height': self.tab.height,
                'min_width': self.tab.min_width,
                'max_width': self.tab.max_width,
                'spacing': self.tab.spacing,
                'border_radius': self.tab.border_radius
            },
            'panel': {
                'margin': self.panel.margin,
                'padding': self.panel.padding,
                'border_radius': self.panel.border_radius,
                'shadow_blur': self.panel.shadow_blur,
                'shadow_color': self.panel.shadow_color
            },
            'control': {
                'button_height': self.control.button_height,
                'button_min_width': self.control.button_min_width,
                'button_padding': self.control.button_padding,
                'button_border_radius': self.control.button_border_radius,
                'button_font_size': self.control.button_font_size
            },
            'table': {
                'row_height': self.table.row_height,
                'header_height': self.table.header_height,
                'cell_padding': self.table.cell_padding,
                'alternating_colors': self.table.alternating_colors,
                'grid_color': self.table.grid_color,
                'selection_color': self.table.selection_color
            },
            'chart': {
                'min_height': self.chart.min_height,
                'padding': self.chart.padding,
                'axis_font_size': self.chart.axis_font_size,
                'legend_font_size': self.chart.legend_font_size,
                'line_width': self.chart.line_width,
                'point_size': self.chart.point_size
            },
            'progress': {
                'height': self.progress.height,
                'border_radius': self.progress.border_radius,
                'animation_ms': self.progress.animation_ms,
                'update_interval': self.progress.update_interval
            },
            'animation': {
                'duration': self.animation.duration,
                'easing': self.animation.easing,
                'hover': self.animation.hover,
                'transition': self.animation.transition
            },
            'colors': {
                'light': {
                    'primary': self.colors_light.primary,
                    'secondary': self.colors_light.secondary,
                    'success': self.colors_light.success,
                    'warning': self.colors_light.warning,
                    'error': self.colors_light.error,
                    'info': self.colors_light.info,
                    'background': self.colors_light.background,
                    'surface': self.colors_light.surface,
                    'text': self.colors_light.text,
                    'border': self.colors_light.border
                },
                'dark': {
                    'primary': self.colors_dark.primary,
                    'secondary': self.colors_dark.secondary,
                    'success': self.colors_dark.success,
                    'warning': self.colors_dark.warning,
                    'error': self.colors_dark.error,
                    'info': self.colors_dark.info,
                    'background': self.colors_dark.background,
                    'surface': self.colors_dark.surface,
                    'text': self.colors_dark.text,
                    'border': self.colors_dark.border
                }
            },
            'breakpoints': {
                'small': self.breakpoints.small,
                'medium': self.breakpoints.medium,
                'large': self.breakpoints.large,
                'xl': self.breakpoints.xl,
                'xxl': self.breakpoints.xxl
            },
            'intervals': {
                'ui': self.intervals.ui,
                'chart': self.intervals.chart,
                'table': self.intervals.table,
                'animation': self.intervals.animation
            },
            'performance': {
                'max_chart_points': self.performance.max_chart_points,
                'table_virtualization': self.performance.table_virtualization,
                'lazy_loading': self.performance.lazy_loading,
                'debounce_delay': self.performance.debounce_delay,
                'throttle_delay': self.performance.throttle_delay
            }
        }


# Global configuration instance
_config: Optional[UIConfig] = None


def get_ui_config() -> UIConfig:
    """
    Get global UI configuration instance.
    
    Returns:
        Global UIConfig instance
    """
    global _config
    if _config is None:
        _config = UIConfig()
    return _config


def reload_ui_config(env_path: Optional[str] = None) -> UIConfig:
    """
    Reload UI configuration from environment.
    
    Args:
        env_path: Optional path to .env file
        
    Returns:
        Reloaded UIConfig instance
    """
    global _config
    _config = UIConfig(env_path)
    return _config
