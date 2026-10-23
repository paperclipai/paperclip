package ai.paperclip.dashboard.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Palette mirrors the web board tokens in ui/src/index.css: a neutral grey
// scale (oklch 0.145 … 0.985, chroma 0) with the sidebar blue as the accent.
private val Neutral50 = Color(0xFFFAFAFA)   // oklch 0.985
private val Neutral100 = Color(0xFFF5F5F5)  // oklch 0.97  muted / secondary
private val Neutral150 = Color(0xFFEDEDED)
private val Neutral200 = Color(0xFFE5E5E5)  // oklch 0.922 border
private val Neutral400 = Color(0xFFA1A1A1)  // oklch 0.708
private val Neutral500 = Color(0xFF737373)  // oklch 0.556 muted-foreground
private val Neutral700 = Color(0xFF404040)
private val Neutral750 = Color(0xFF333333)  // dark muted-highlight
private val Neutral800 = Color(0xFF262626)  // oklch 0.269 dark muted
private val Neutral850 = Color(0xFF1F1F1F)
private val Neutral900 = Color(0xFF171717)  // oklch 0.205
private val Neutral950 = Color(0xFF0A0A0A)  // oklch 0.145
private val Blue600 = Color(0xFF2563EB)
private val Blue400 = Color(0xFF60A5FA)
private val RedLight = Color(0xFFE7000B)    // oklch 0.577 0.245 27.3
private val RedDark = Color(0xFFFB2C36)     // oklch 0.637 0.237 25.3

private val LightColors = lightColorScheme(
    primary = Neutral900,
    onPrimary = Neutral50,
    primaryContainer = Neutral100,
    onPrimaryContainer = Neutral900,
    secondary = Neutral700,
    onSecondary = Neutral50,
    secondaryContainer = Neutral200,
    onSecondaryContainer = Neutral900,
    tertiary = Blue600,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFDBEAFE),
    onTertiaryContainer = Color(0xFF1E3A8A),
    error = RedLight,
    onError = Neutral50,
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
    background = Color.White,
    onBackground = Neutral950,
    surface = Color.White,
    onSurface = Neutral950,
    surfaceVariant = Neutral100,
    onSurfaceVariant = Neutral500,
    surfaceTint = Color.Transparent,
    surfaceBright = Color.White,
    surfaceDim = Neutral100,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Neutral50,
    surfaceContainer = Neutral50,
    surfaceContainerHigh = Neutral100,
    surfaceContainerHighest = Neutral100,
    inverseSurface = Neutral900,
    inverseOnSurface = Neutral50,
    inversePrimary = Neutral200,
    outline = Neutral200,
    outlineVariant = Neutral150,
    scrim = Color.Black,
)

private val DarkColors = darkColorScheme(
    primary = Neutral200,
    onPrimary = Neutral900,
    primaryContainer = Neutral800,
    onPrimaryContainer = Neutral50,
    secondary = Neutral400,
    onSecondary = Neutral900,
    secondaryContainer = Neutral750,
    onSecondaryContainer = Neutral50,
    tertiary = Blue400,
    onTertiary = Neutral950,
    tertiaryContainer = Color(0xFF1E3A8A),
    onTertiaryContainer = Color(0xFFDBEAFE),
    error = RedDark,
    onError = Neutral50,
    errorContainer = Color(0xFF450A0A),
    onErrorContainer = Color(0xFFFECACA),
    background = Neutral900,
    onBackground = Neutral50,
    surface = Neutral900,
    onSurface = Neutral50,
    surfaceVariant = Neutral800,
    onSurfaceVariant = Neutral400,
    surfaceTint = Color.Transparent,
    surfaceBright = Neutral800,
    surfaceDim = Neutral950,
    surfaceContainerLowest = Neutral950,
    surfaceContainerLow = Neutral900,
    surfaceContainer = Neutral850,
    surfaceContainerHigh = Neutral850,
    surfaceContainerHighest = Neutral800,
    inverseSurface = Neutral50,
    inverseOnSurface = Neutral900,
    inversePrimary = Neutral900,
    outline = Color(0x1AFFFFFF),            // oklch(1 0 0 / 10%) border
    outlineVariant = Color(0x14FFFFFF),
    scrim = Color.Black,
)

// --radius: 0.5rem with the web's sm/md/lg/xl multipliers.
private val PaperclipShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(11.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

// Denser, flatter type than Material defaults, closer to the web board.
private val PaperclipTypography = Typography().run {
    copy(
        displaySmall = displaySmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
        headlineMedium = headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.25).sp),
        headlineSmall = headlineSmall.copy(fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.25).sp),
        titleLarge = titleLarge.copy(fontSize = 19.sp, fontWeight = FontWeight.SemiBold),
        titleMedium = titleMedium.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = titleSmall.copy(fontWeight = FontWeight.SemiBold),
        bodyLarge = bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp, letterSpacing = 0.sp),
        bodyMedium = bodyMedium.copy(letterSpacing = 0.sp),
        labelLarge = labelLarge.copy(fontWeight = FontWeight.Medium, letterSpacing = 0.sp),
        labelMedium = labelMedium.copy(letterSpacing = 0.sp),
        labelSmall = labelSmall.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.2.sp),
    )
}

@Composable
fun PaperclipTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        shapes = PaperclipShapes,
        typography = PaperclipTypography,
        content = content,
    )
}
