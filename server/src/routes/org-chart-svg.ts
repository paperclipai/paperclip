/**
 * Server-side SVG renderer for Paperclip org charts.
 * Supports 5 visual styles: monochrome, nebula, circuit, warmth, schematic.
 * Pure SVG output — no browser/Playwright needed. PNG via sharp.
 */

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: OrgNode[];
  /** Populated by collapseTree: the flattened list of hidden descendants for avatar grid rendering. */
  collapsedReports?: OrgNode[];
}

export type OrgChartStyle = "monochrome" | "nebula" | "circuit" | "warmth" | "schematic";

export const ORG_CHART_STYLES: OrgChartStyle[] = ["monochrome", "nebula", "circuit", "warmth", "schematic"];

interface LayoutNode {
  node: OrgNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LayoutNode[];
}

// ── Style theme definitions ──────────────────────────────────────

interface StyleTheme {
  bgColor: string;
  cardBg: string;
  cardBorder: string;
  cardRadius: number;
  cardShadow: string | null;
  lineColor: string;
  lineWidth: number;
  nameColor: string;
  roleColor: string;
  font: string;
  watermarkColor: string;
  /** Extra SVG defs (filters, patterns, gradients) */
  defs: (svgW: number, svgH: number) => string;
  /** Extra background elements after the main bg rect */
  bgExtras: (svgW: number, svgH: number) => string;
  /** Custom card renderer — if null, uses default avatar+name+role */
  renderCard: ((ln: LayoutNode, theme: StyleTheme) => string) | null;
  /** Per-card accent (top bar, border glow, etc.) */
  cardAccent: ((tag: string) => string) | null;
}

// ── Role config with Twemoji SVG inlines (viewBox 0 0 36 36) ─────
//
// Each `emojiSvg` contains the inner SVG paths from Twemoji (CC-BY 4.0).
// These render as colorful emoji-style icons inside the avatar circle,
// without needing a browser or emoji font.

const ROLE_ICONS: Record<string, {
  bg: string;
  roleLabel: string;
  accentColor: string;
  /** Twemoji inner SVG content (paths only, viewBox 0 0 36 36) */
  emojiSvg: string;
  /** Fallback monochrome icon path (16×16 viewBox) for minimal rendering */
  iconPath: string;
  iconColor: string;
}> = {
  ceo: {
    bg: "#fef3c7", roleLabel: "Chief Executive", accentColor: "#f0883e", iconColor: "#92400e",
    iconPath: "M8 1l2.2 4.5L15 6.2l-3.5 3.4.8 4.9L8 12.2 3.7 14.5l.8-4.9L1 6.2l4.8-.7z",
    // 👑 Crown
    emojiSvg: `<path fill="#F4900C" d="M14.174 17.075L6.75 7.594l-3.722 9.481z"/><path fill="#F4900C" d="M17.938 5.534l-6.563 12.389H24.5z"/><path fill="#F4900C" d="M21.826 17.075l7.424-9.481 3.722 9.481z"/><path fill="#FFCC4D" d="M28.669 15.19L23.887 3.523l-5.88 11.668-.007.003-.007-.004-5.88-11.668L7.331 15.19C4.197 10.833 1.28 8.042 1.28 8.042S3 20.75 3 33h30c0-12.25 1.72-24.958 1.72-24.958s-2.917 2.791-6.051 7.148z"/><circle fill="#5C913B" cx="17.957" cy="22" r="3.688"/><circle fill="#981CEB" cx="26.463" cy="22" r="2.412"/><circle fill="#DD2E44" cx="32.852" cy="22" r="1.986"/><circle fill="#981CEB" cx="9.45" cy="22" r="2.412"/><circle fill="#DD2E44" cx="3.061" cy="22" r="1.986"/><path fill="#FFAC33" d="M33 34H3c-.552 0-1-.447-1-1s.448-1 1-1h30c.553 0 1 .447 1 1s-.447 1-1 1zm0-3.486H3c-.552 0-1-.447-1-1s.448-1 1-1h30c.553 0 1 .447 1 1s-.447 1-1 1z"/><circle fill="#FFCC4D" cx="1.447" cy="8.042" r="1.407"/><circle fill="#F4900C" cx="6.75" cy="7.594" r="1.192"/><circle fill="#FFCC4D" cx="12.113" cy="3.523" r="1.784"/><circle fill="#FFCC4D" cx="34.553" cy="8.042" r="1.407"/><circle fill="#F4900C" cx="29.25" cy="7.594" r="1.192"/><circle fill="#FFCC4D" cx="23.887" cy="3.523" r="1.784"/><circle fill="#F4900C" cx="17.938" cy="5.534" r="1.784"/>`,
  },
  cto: {
    bg: "#dbeafe", roleLabel: "Technology", accentColor: "#58a6ff", iconColor: "#1e40af",
    iconPath: "M2 3l5 5-5 5M9 13h5",
    // 💻 Laptop
    emojiSvg: `<path fill="#CCD6DD" d="M34 29.096c-.417-.963-.896-2.008-2-2.008h-1c1.104 0 2-.899 2-2.008V8.008C33 6.899 32.104 6 31 6H5c-1.104 0-2 .899-2 2.008V25.08c0 1.109.896 2.008 2 2.008H4c-1.104 0-1.667 1.004-2 2.008l-2 4.895C0 35.101.896 36 2 36h32c1.104 0 2-.899 2-2.008l-2-4.896z"/><path fill="#9AAAB4" d="M.008 34.075l.006.057.17.692C.5 35.516 1.192 36 2 36h32c1.076 0 1.947-.855 1.992-1.925H.008z"/><path fill="#5DADEC" d="M31 24.075c0 .555-.447 1.004-1 1.004H6c-.552 0-1-.449-1-1.004V9.013c0-.555.448-1.004 1-1.004h24c.553 0 1 .45 1 1.004v15.062z"/><path fill="#AEBBC1" d="M32.906 31.042l-.76-2.175c-.239-.46-.635-.837-1.188-.837H5.11c-.552 0-.906.408-1.156 1.036l-.688 1.977c-.219.596.448 1.004 1 1.004h7.578s.937-.047 1.103-.608c.192-.648.415-1.624.463-1.796.074-.264.388-.531.856-.531h8.578c.5 0 .746.253.811.566.042.204.312 1.141.438 1.782.111.571 1.221.586 1.221.586h6.594c.551 0 1.217-.471.998-1.004z"/><path fill="#9AAAB4" d="M22.375 33.113h-7.781c-.375 0-.538-.343-.484-.675.054-.331.359-1.793.383-1.963.023-.171.274-.375.524-.375h7.015c.297 0 .49.163.55.489.059.327.302 1.641.321 1.941.019.301-.169.583-.528.583z"/>`,
  },
  cmo: {
    bg: "#dcfce7", roleLabel: "Marketing", accentColor: "#3fb950", iconColor: "#166534",
    iconPath: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM1 8h14M8 1c-2 2-3 4.5-3 7s1 5 3 7c2-2 3-4.5 3-7s-1-5-3-7z",
    // 🌐 Globe with meridians
    emojiSvg: `<path fill="#3B88C3" d="M18 0C8.059 0 0 8.059 0 18s8.059 18 18 18 18-8.059 18-18S27.941 0 18 0zM2.05 19h3.983c.092 2.506.522 4.871 1.229 7H4.158c-1.207-2.083-1.95-4.459-2.108-7zM19 8V2.081c2.747.436 5.162 2.655 6.799 5.919H19zm7.651 2c.754 2.083 1.219 4.46 1.317 7H19v-7h7.651zM17 2.081V8h-6.799C11.837 4.736 14.253 2.517 17 2.081zM17 10v7H8.032c.098-2.54.563-4.917 1.317-7H17zM6.034 17H2.05c.158-2.54.901-4.917 2.107-7h3.104c-.705 2.129-1.135 4.495-1.227 7zm1.998 2H17v7H9.349c-.754-2.083-1.219-4.459-1.317-7zM17 28v5.919c-2.747-.437-5.163-2.655-6.799-5.919H17zm2 5.919V28h6.8c-1.637 3.264-4.053 5.482-6.8 5.919zM19 26v-7h8.969c-.099 2.541-.563 4.917-1.317 7H19zm10.967-7h3.982c-.157 2.541-.9 4.917-2.107 7h-3.104c.706-2.129 1.136-4.494 1.229-7zm0-2c-.093-2.505-.523-4.871-1.229-7h3.104c1.207 2.083 1.95 4.46 2.107 7h-3.982zm.512-9h-2.503c-.717-1.604-1.606-3.015-2.619-4.199C27.346 4.833 29.089 6.267 30.479 8zM10.643 3.801C9.629 4.985 8.74 6.396 8.023 8H5.521c1.39-1.733 3.133-3.166 5.122-4.199zM5.521 28h2.503c.716 1.604 1.605 3.015 2.619 4.198C8.654 31.166 6.911 29.733 5.521 28zm19.836 4.198c1.014-1.184 1.902-2.594 2.619-4.198h2.503c-1.39 1.733-3.133 3.166-5.122 4.198z"/>`,
  },
  cfo: {
    bg: "#fef3c7", roleLabel: "Finance", accentColor: "#f0883e", iconColor: "#92400e",
    iconPath: "M8 1v14M5 4.5C5 3.1 6.3 2 8 2s3 1.1 3 2.5S9.7 7 8 7 5 8.1 5 9.5 6.3 12 8 12s3-1.1 3-2.5",
    // 📊 Bar chart
    emojiSvg: `<path fill="#CCD6DD" d="M31 2H5C3.343 2 2 3.343 2 5v26c0 1.657 1.343 3 3 3h26c1.657 0 3-1.343 3-3V5c0-1.657-1.343-3-3-3z"/><path fill="#E1E8ED" d="M31 1H5C2.791 1 1 2.791 1 5v26c0 2.209 1.791 4 4 4h26c2.209 0 4-1.791 4-4V5c0-2.209-1.791-4-4-4zm0 2c1.103 0 2 .897 2 2v4h-6V3h4zm-4 16h6v6h-6v-6zm0-2v-6h6v6h-6zM25 3v6h-6V3h6zm-6 8h6v6h-6v-6zm0 8h6v6h-6v-6zM17 3v6h-6V3h6zm-6 8h6v6h-6v-6zm0 8h6v6h-6v-6zM3 5c0-1.103.897-2 2-2h4v6H3V5zm0 6h6v6H3v-6zm0 8h6v6H3v-6zm2 14c-1.103 0-2-.897-2-2v-4h6v6H5zm6 0v-6h6v6h-6zm8 0v-6h6v6h-6zm12 0h-4v-6h6v4c0 1.103-.897 2-2 2z"/><path fill="#5C913B" d="M13 33H7V16c0-1.104.896-2 2-2h2c1.104 0 2 .896 2 2v17z"/><path fill="#3B94D9" d="M29 33h-6V9c0-1.104.896-2 2-2h2c1.104 0 2 .896 2 2v24z"/><path fill="#DD2E44" d="M21 33h-6V23c0-1.104.896-2 2-2h2c1.104 0 2 .896 2 2v10z"/>`,
  },
  coo: {
    bg: "#e0f2fe", roleLabel: "Operations", accentColor: "#58a6ff", iconColor: "#075985",
    iconPath: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
    // ⚙️ Gear
    emojiSvg: `<path fill="#66757F" d="M34 15h-3.362c-.324-1.369-.864-2.651-1.582-3.814l2.379-2.379c.781-.781.781-2.048 0-2.829l-1.414-1.414c-.781-.781-2.047-.781-2.828 0l-2.379 2.379C23.65 6.225 22.369 5.686 21 5.362V2c0-1.104-.896-2-2-2h-2c-1.104 0-2 .896-2 2v3.362c-1.369.324-2.651.864-3.814 1.582L8.808 4.565c-.781-.781-2.048-.781-2.828 0L4.565 5.979c-.781.781-.781 2.048-.001 2.829l2.379 2.379C6.225 12.35 5.686 13.632 5.362 15H2c-1.104 0-2 .896-2 2v2c0 1.104.896 2 2 2h3.362c.324 1.368.864 2.65 1.582 3.813l-2.379 2.379c-.78.78-.78 2.048.001 2.829l1.414 1.414c.78.78 2.047.78 2.828 0l2.379-2.379c1.163.719 2.445 1.258 3.814 1.582V34c0 1.104.896 2 2 2h2c1.104 0 2-.896 2-2v-3.362c1.368-.324 2.65-.864 3.813-1.582l2.379 2.379c.781.781 2.047.781 2.828 0l1.414-1.414c.781-.781.781-2.048 0-2.829l-2.379-2.379c.719-1.163 1.258-2.445 1.582-3.814H34c1.104 0 2-.896 2-2v-2C36 15.896 35.104 15 34 15zM18 26c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8z"/>`,
  },
  engineer: {
    bg: "#f3e8ff", roleLabel: "Engineering", accentColor: "#bc8cff", iconColor: "#6b21a8",
    iconPath: "M5 3L1 8l4 5M11 3l4 5-4 5",
    // ⌨️ Keyboard
    emojiSvg: `<path fill="#99AAB5" d="M36 28c0 1.104-.896 2-2 2H2c-1.104 0-2-.896-2-2V12c0-1.104.896-2 2-2h32c1.104 0 2 .896 2 2v16z"/><path d="M5.5 19c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zm-26 4c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.448 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.552 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h1c.553 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zm4 0c0 .553-.447 1-1 1h-1c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h1c.553 0 1 .447 1 1v1zM10 27c0 .553-.448 1-1 1H7c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h2c.552 0 1 .447 1 1v1zm20 0c0 .553-.447 1-1 1h-2c-.553 0-1-.447-1-1v-1c0-.553.447-1 1-1h2c.553 0 1 .447 1 1v1zm-5 0c0 .553-.447 1-1 1H12c-.552 0-1-.447-1-1v-1c0-.553.448-1 1-1h12c.553 0 1 .447 1 1v1zM5.5 13.083c0 .552-.448 1-1 1h-1c-.552 0-1-.448-1-1s.448-1 1-1h1c.552 0 1 .448 1 1zm4 0c0 .552-.448 1-1 1h-1c-.552 0-1-.448-1-1s.448-1 1-1h1c.552 0 1 .448 1 1zm4 0c0 .552-.448 1-1 1h-1c-.552 0-1-.448-1-1s.448-1 1-1h1c.552 0 1 .448 1 1zm4 0c0 .552-.448 1-1 1h-1c-.552 0-1-.448-1-1s.448-1 1-1h1c.552 0 1 .448 1 1zm4 0c0 .552-.447 1-1 1h-1c-.553 0-1-.448-1-1s.447-1 1-1h1c.553 0 1 .448 1 1zm4 0c0 .552-.447 1-1 1h-1c-.553 0-1-.448-1-1s.447-1 1-1h1c.553 0 1 .448 1 1zm4 0c0 .552-.447 1-1 1h-1c-.553 0-1-.448-1-1s.447-1 1-1h1c.553 0 1 .448 1 1zm4 0c0 .552-.447 1-1 1h-1c-.553 0-1-.448-1-1s.447-1 1-1h1c.553 0 1 .448 1 1z" fill="#292F33"/>`,
  },
  quality: {
    bg: "#ffe4e6", roleLabel: "Quality", accentColor: "#f778ba", iconColor: "#9f1239",
    iconPath: "M4 8l3 3 5-6M8 1L2 4v4c0 3.5 2.6 6.8 6 8 3.4-1.2 6-4.5 6-8V4z",
    // 🔬 Microscope
    emojiSvg: `<g fill="#66757F"><path d="M19.78 21.345l-6.341-6.342-.389 4.38 2.35 2.351z"/><path d="M15.4 22.233c-.132 0-.259-.053-.354-.146l-2.351-2.351c-.104-.104-.158-.25-.145-.397l.389-4.38c.017-.193.145-.359.327-.425.182-.067.388-.021.524.116l6.341 6.342c.138.138.183.342.116.524s-.232.31-.426.327l-4.379.389-.042.001zm-1.832-3.039l2.021 2.021 3.081-.273-4.828-4.828-.274 3.08z"/></g><path fill="#8899A6" d="M31 32h-3c0-3.314-2.63-6-5.875-6-3.244 0-5.875 2.686-5.875 6H8.73c0-1.104-.895-2-2-2-1.104 0-2 .896-2 2-1.104 0-2 .896-2 2s.896 2 2 2H31c1.104 0 2-.896 2-2s-.896-2-2-2z"/><path fill="#8899A6" d="M20 10v4c3.866 0 7 3.134 7 7s-3.134 7-7 7h-8.485c2.018 2.443 5.069 4 8.485 4 6.075 0 11-4.925 11-11s-4.925-11-11-11z"/><path fill="#67757F" d="M16.414 30.414c-.781.781-2.047.781-2.828 0l-9.899-9.9c-.781-.781-.781-2.047 0-2.828.781-.781 2.047-.781 2.829 0l9.899 9.9c.78.781.78 2.047-.001 2.828zm-7.225-1.786c.547-.077 1.052.304 1.129.851.077.547-.305 1.053-.851 1.129l-5.942.834c-.547.077-1.052-.305-1.129-.851-.077-.547.305-1.053.852-1.13l5.941-.833z"/><path fill="#66757F" d="M27.341 2.98l4.461 4.461-3.806 3.807-4.461-4.461z"/><path fill="#AAB8C2" d="M34.037 7.083c-.827.827-2.17.827-2.997 0l-3.339-3.34c-.827-.826-.827-2.169 0-2.996.827-.826 2.17-.826 2.995 0l3.342 3.34c.826.827.826 2.168-.001 2.996zm-14.56 15.026l-6.802-6.803c-.389-.389-.389-1.025 0-1.414l9.858-9.858c.389-.389 1.025-.389 1.414 0l6.801 6.803c.389.389.389 1.025 0 1.414l-9.858 9.858c-.388.389-1.024.389-1.413 0z"/><path fill="#E1E8ED" d="M13.766 12.8l1.638-1.637 8.216 8.216-1.638 1.637z"/>`,
  },
  design: {
    bg: "#fce7f3", roleLabel: "Design", accentColor: "#79c0ff", iconColor: "#9d174d",
    iconPath: "M12 2l2 2-9 9H3v-2zM9.5 4.5l2 2",
    // 🪄 Magic wand
    emojiSvg: `<path fill="#292F33" d="M3.651 29.852L29.926 3.576c.391-.391 2.888 2.107 2.497 2.497L6.148 32.349c-.39.391-2.888-2.107-2.497-2.497z"/><path fill="#66757F" d="M30.442 4.051L4.146 30.347l.883.883L31.325 4.934z"/><path fill="#E1E8ED" d="M34.546 2.537l-.412-.412-.671-.671c-.075-.075-.165-.123-.255-.169-.376-.194-.844-.146-1.159.169l-2.102 2.102.495.495.883.883 1.119 1.119 2.102-2.102c.391-.391.391-1.024 0-1.414zM5.029 31.23l-.883-.883-.495-.495-2.209 2.208c-.315.315-.363.783-.169 1.159.046.09.094.18.169.255l.671.671.412.412c.391.391 1.024.391 1.414 0l2.208-2.208-1.118-1.119z"/><path fill="#F5F8FA" d="M31.325 4.934l2.809-2.809-.671-.671c-.075-.075-.165-.123-.255-.169l-2.767 2.767.884.882zM4.146 30.347L1.273 33.22c.046.09.094.18.169.255l.671.671 2.916-2.916-.883-.883z"/><path d="M28.897 14.913l1.542-.571.6-2.2c.079-.29.343-.491.644-.491.3 0 .564.201.643.491l.6 2.2 1.542.571c.262.096.435.346.435.625s-.173.529-.435.625l-1.534.568-.605 2.415c-.074.296-.341.505-.646.505-.306 0-.573-.209-.647-.505l-.605-2.415-1.534-.568c-.262-.096-.435-.346-.435-.625 0-.278.173-.528.435-.625M11.961 5.285l2.61-.966.966-2.61c.16-.433.573-.72 1.035-.72.461 0 .874.287 1.035.72l.966 2.61 2.609.966c.434.161.721.573.721 1.035 0 .462-.287.874-.721 1.035l-2.609.966-.966 2.61c-.161.433-.574.72-1.035.72-.462 0-.875-.287-1.035-.72l-.966-2.61-2.61-.966c-.433-.161-.72-.573-.72-1.035.001-.462.288-.874.72-1.035M24.13 20.772l1.383-.512.512-1.382c.085-.229.304-.381.548-.381.244 0 .463.152.548.381l.512 1.382 1.382.512c.23.085.382.304.382.548 0 .245-.152.463-.382.548l-1.382.512-.512 1.382c-.085.229-.304.381-.548.381-.245 0-.463-.152-.548-.381l-.512-1.382-1.383-.512c-.229-.085-.381-.304-.381-.548 0-.245.152-.463.381-.548" fill="#FFAC33"/>`,
  },
  finance: {
    bg: "#fef3c7", roleLabel: "Finance", accentColor: "#f0883e", iconColor: "#92400e",
    iconPath: "M8 1v14M5 4.5C5 3.1 6.3 2 8 2s3 1.1 3 2.5S9.7 7 8 7 5 8.1 5 9.5 6.3 12 8 12s3-1.1 3-2.5",
    // 📊 Bar chart (same as CFO)
    emojiSvg: `<path fill="#CCD6DD" d="M31 2H5C3.343 2 2 3.343 2 5v26c0 1.657 1.343 3 3 3h26c1.657 0 3-1.343 3-3V5c0-1.657-1.343-3-3-3z"/><path fill="#E1E8ED" d="M31 1H5C2.791 1 1 2.791 1 5v26c0 2.209 1.791 4 4 4h26c2.209 0 4-1.791 4-4V5c0-2.209-1.791-4-4-4zm0 2c1.103 0 2 .897 2 2v4h-6V3h4zm-4 16h6v6h-6v-6zm0-2v-6h6v6h-6zM25 3v6h-6V3h6zm-6 8h6v6h-6v-6zm0 8h6v6h-6v-6zM17 3v6h-6V3h6zm-6 8h6v6h-6v-6zm0 8h6v6h-6v-6zM3 5c0-1.103.897-2 2-2h4v6H3V5zm0 6h6v6H3v-6zm0 8h6v6H3v-6zm2 14c-1.103 0-2-.897-2-2v-4h6v6H5zm6 0v-6h6v6h-6zm8 0v-6h6v6h-6zm12 0h-4v-6h6v4c0 1.103-.897 2-2 2z"/><path fill="#5C913B" d="M13 33H7V16c0-1.104.896-2 2-2h2c1.104 0 2 .896 2 2v17z"/><path fill="#3B94D9" d="M29 33h-6V9c0-1.104.896-2 2-2h2c1.104 0 2 .896 2 2v24z"/><path fill="#DD2E44" d="M21 33h-6V23c0-1.104.896-2 2-2h2c1.104 0 2 .896 2 2v10z"/>`,
  },
  operations: {
    bg: "#e0f2fe", roleLabel: "Operations", accentColor: "#58a6ff", iconColor: "#075985",
    iconPath: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
    // ⚙️ Gear (same as COO)
    emojiSvg: `<path fill="#66757F" d="M34 15h-3.362c-.324-1.369-.864-2.651-1.582-3.814l2.379-2.379c.781-.781.781-2.048 0-2.829l-1.414-1.414c-.781-.781-2.047-.781-2.828 0l-2.379 2.379C23.65 6.225 22.369 5.686 21 5.362V2c0-1.104-.896-2-2-2h-2c-1.104 0-2 .896-2 2v3.362c-1.369.324-2.651.864-3.814 1.582L8.808 4.565c-.781-.781-2.048-.781-2.828 0L4.565 5.979c-.781.781-.781 2.048-.001 2.829l2.379 2.379C6.225 12.35 5.686 13.632 5.362 15H2c-1.104 0-2 .896-2 2v2c0 1.104.896 2 2 2h3.362c.324 1.368.864 2.65 1.582 3.813l-2.379 2.379c-.78.78-.78 2.048.001 2.829l1.414 1.414c.78.78 2.047.78 2.828 0l2.379-2.379c1.163.719 2.445 1.258 3.814 1.582V34c0 1.104.896 2 2 2h2c1.104 0 2-.896 2-2v-3.362c1.368-.324 2.65-.864 3.813-1.582l2.379 2.379c.781.781 2.047.781 2.828 0l1.414-1.414c.781-.781.781-2.048 0-2.829l-2.379-2.379c.719-1.163 1.258-2.445 1.582-3.814H34c1.104 0 2-.896 2-2v-2C36 15.896 35.104 15 34 15zM18 26c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8z"/>`,
  },
  default: {
    bg: "#f3e8ff", roleLabel: "Agent", accentColor: "#bc8cff", iconColor: "#6b21a8",
    iconPath: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 14c0-3.3 2.7-4 6-4s6 .7 6 4",
    // 👤 Person silhouette
    emojiSvg: `<path fill="#269" d="M24 26.799v-2.566c2-1.348 4.08-3.779 4.703-6.896.186.103.206.17.413.17.991 0 1.709-1.287 1.709-2.873 0-1.562-.823-2.827-1.794-2.865.187-.674.293-1.577.293-2.735C29.324 5.168 26 .527 18.541.527c-6.629 0-10.777 4.641-10.777 8.507 0 1.123.069 2.043.188 2.755-.911.137-1.629 1.352-1.629 2.845 0 1.587.804 2.873 1.796 2.873.206 0 .025-.067.209-.17C8.952 20.453 11 22.885 13 24.232v2.414c-5 .645-12 3.437-12 6.23v1.061C1 35 2.076 35 3.137 35h29.725C33.924 35 35 35 35 33.938v-1.061c0-2.615-6-5.225-11-6.078z"/>`,
  },
};

function guessRoleTag(node: OrgNode): string {
  const name = node.name.toLowerCase();
  const role = node.role.toLowerCase();
  if (name === "ceo" || role.includes("chief executive")) return "ceo";
  if (name === "cto" || role.includes("chief technology") || role.includes("technology")) return "cto";
  if (name === "cmo" || role.includes("chief marketing") || role.includes("marketing")) return "cmo";
  if (name === "cfo" || role.includes("chief financial")) return "cfo";
  if (name === "coo" || role.includes("chief operating")) return "coo";
  if (role.includes("engineer") || role.includes("eng")) return "engineer";
  if (role.includes("quality") || role.includes("qa")) return "quality";
  if (role.includes("design")) return "design";
  if (role.includes("finance")) return "finance";
  if (role.includes("operations") || role.includes("ops")) return "operations";
  return "default";
}

function getRoleInfo(node: OrgNode) {
  const tag = guessRoleTag(node);
  return { tag, ...(ROLE_ICONS[tag] || ROLE_ICONS.default) };
}

// ── Style themes ─────────────────────────────────────────────────

const THEMES: Record<OrgChartStyle, StyleTheme> = {
  // 01 — Monochrome (Vercel-inspired, dark minimal)
  monochrome: {
    bgColor: "#18181b",
    cardBg: "#18181b",
    cardBorder: "#27272a",
    cardRadius: 6,
    cardShadow: null,
    lineColor: "#3f3f46",
    lineWidth: 1.5,
    nameColor: "#fafafa",
    roleColor: "#71717a",
    font: "'Inter', system-ui, sans-serif",
    watermarkColor: "rgba(255,255,255,0.25)",
    defs: () => "",
    bgExtras: () => "",
    renderCard: null,
    cardAccent: null,
  },

  // 02 — Nebula (glassmorphism on cosmic gradient)
  nebula: {
    bgColor: "#0f0c29",
    cardBg: "rgba(255,255,255,0.07)",
    cardBorder: "rgba(255,255,255,0.12)",
    cardRadius: 6,
    cardShadow: null,
    lineColor: "rgba(255,255,255,0.25)",
    lineWidth: 1.5,
    nameColor: "#ffffff",
    roleColor: "rgba(255,255,255,0.45)",
    font: "'Inter', system-ui, sans-serif",
    watermarkColor: "rgba(255,255,255,0.2)",
    defs: (_w, _h) => `
      <linearGradient id="nebula-bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f0c29"/>
        <stop offset="50%" stop-color="#302b63"/>
        <stop offset="100%" stop-color="#24243e"/>
      </linearGradient>
      <radialGradient id="nebula-glow1" cx="25%" cy="30%" r="40%">
        <stop offset="0%" stop-color="rgba(99,102,241,0.12)"/>
        <stop offset="100%" stop-color="transparent"/>
      </radialGradient>
      <radialGradient id="nebula-glow2" cx="75%" cy="65%" r="35%">
        <stop offset="0%" stop-color="rgba(168,85,247,0.08)"/>
        <stop offset="100%" stop-color="transparent"/>
      </radialGradient>`,
    bgExtras: (w, h) => `
      <rect width="${w}" height="${h}" fill="url(#nebula-bg)" rx="6"/>
      <rect width="${w}" height="${h}" fill="url(#nebula-glow1)"/>
      <rect width="${w}" height="${h}" fill="url(#nebula-glow2)"/>`,
    renderCard: null,
    cardAccent: null,
  },

  // 03 — Circuit (Linear/Raycast — indigo traces, amethyst CEO)
  circuit: {
    bgColor: "#0c0c0e",
    cardBg: "rgba(99,102,241,0.04)",
    cardBorder: "rgba(99,102,241,0.18)",
    cardRadius: 5,
    cardShadow: null,
    lineColor: "rgba(99,102,241,0.35)",
    lineWidth: 1.5,
    nameColor: "#e4e4e7",
    roleColor: "#6366f1",
    font: "'Inter', system-ui, sans-serif",
    watermarkColor: "rgba(99,102,241,0.3)",
    defs: () => "",
    bgExtras: () => "",
    renderCard: (ln: LayoutNode, theme: StyleTheme) => {
      const { tag, roleLabel, emojiSvg } = getRoleInfo(ln.node);
      const cx = ln.x + ln.width / 2;
      const isCeo = tag === "ceo";
      const borderColor = isCeo ? "rgba(168,85,247,0.35)" : theme.cardBorder;
      const bgColor = isCeo ? "rgba(168,85,247,0.06)" : theme.cardBg;

      const avatarCY = ln.y + 27;
      const nameY = ln.y + 66;
      const roleY = ln.y + 82;

      return `<g>
        <rect x="${ln.x}" y="${ln.y}" width="${ln.width}" height="${ln.height}" rx="${theme.cardRadius}" fill="${bgColor}" stroke="${borderColor}" stroke-width="1"/>
        ${renderEmojiAvatar(cx, avatarCY, 17, "rgba(99,102,241,0.08)", emojiSvg, "rgba(99,102,241,0.15)")}
        <text x="${cx}" y="${nameY}" text-anchor="middle" font-family="${theme.font}" font-size="13" font-weight="600" fill="${theme.nameColor}" letter-spacing="-0.005em">${escapeXml(ln.node.name)}</text>
        <text x="${cx}" y="${roleY}" text-anchor="middle" font-family="${theme.font}" font-size="10" font-weight="500" fill="${theme.roleColor}" letter-spacing="0.07em">${escapeXml(roleLabel).toUpperCase()}</text>
      </g>`;
    },
    cardAccent: null,
  },

  // 04 — Warmth (Airbnb — light, colored avatars, soft shadows)
  warmth: {
    bgColor: "#fafaf9",
    cardBg: "#ffffff",
    cardBorder: "#e7e5e4",
    cardRadius: 6,
    cardShadow: "rgba(0,0,0,0.05)",
    lineColor: "#d6d3d1",
    lineWidth: 2,
    nameColor: "#1c1917",
    roleColor: "#78716c",
    font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    watermarkColor: "rgba(0,0,0,0.25)",
    defs: () => "",
    bgExtras: () => "",
    renderCard: null,
    cardAccent: null,
  },

  // 05 — Schematic (Blueprint — grid bg, monospace, colored top-bars)
  schematic: {
    bgColor: "#0d1117",
    cardBg: "rgba(13,17,23,0.92)",
    cardBorder: "#30363d",
    cardRadius: 4,
    cardShadow: null,
    lineColor: "#30363d",
    lineWidth: 1.5,
    nameColor: "#c9d1d9",
    roleColor: "#8b949e",
    font: "'JetBrains Mono', 'SF Mono', monospace",
    watermarkColor: "rgba(139,148,158,0.3)",
    defs: (w, h) => `
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(48,54,61,0.25)" stroke-width="1"/>
      </pattern>`,
    bgExtras: (w, h) => `<rect width="${w}" height="${h}" fill="url(#grid)"/>`,
    renderCard: (ln: LayoutNode, theme: StyleTheme) => {
      const { tag, accentColor, emojiSvg } = getRoleInfo(ln.node);
      const cx = ln.x + ln.width / 2;

      // Schematic uses monospace role labels
      const schemaRoles: Record<string, string> = {
        ceo: "chief_executive", cto: "chief_technology", cmo: "chief_marketing",
        cfo: "chief_financial", coo: "chief_operating", engineer: "engineer",
        quality: "quality_assurance", design: "designer", finance: "finance",
        operations: "operations", default: "agent",
      };
      const roleText = schemaRoles[tag] || schemaRoles.default;

      const avatarCY = ln.y + 27;
      const nameY = ln.y + 66;
      const roleY = ln.y + 82;

      return `<g>
        <rect x="${ln.x}" y="${ln.y}" width="${ln.width}" height="${ln.height}" rx="${theme.cardRadius}" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1"/>
        <rect x="${ln.x}" y="${ln.y}" width="${ln.width}" height="2" rx="${theme.cardRadius} ${theme.cardRadius} 0 0" fill="${accentColor}"/>
        ${renderEmojiAvatar(cx, avatarCY, 17, "rgba(48,54,61,0.3)", emojiSvg, theme.cardBorder)}
        <text x="${cx}" y="${nameY}" text-anchor="middle" font-family="${theme.font}" font-size="12" font-weight="600" fill="${theme.nameColor}">${escapeXml(ln.node.name)}</text>
        <text x="${cx}" y="${roleY}" text-anchor="middle" font-family="${theme.font}" font-size="10" fill="${theme.roleColor}" letter-spacing="0.02em">${escapeXml(roleText)}</text>
      </g>`;
    },
    cardAccent: null,
  },
};

// ── Layout constants ─────────────────────────────────────────────

const CARD_H = 96;
const CARD_MIN_W = 150;
const CARD_PAD_X = 22;
const AVATAR_SIZE = 34;
const GAP_X = 24;
const GAP_Y = 56;

// ── Collapsed avatar grid constants ─────────────────────────────
const MINI_AVATAR_SIZE = 14;
const MINI_AVATAR_GAP = 6;
const MINI_AVATAR_PADDING = 10;
const MINI_AVATAR_MAX_COLS = 8; // max avatars per row in the grid
const PADDING = 48;
const LOGO_PADDING = 16;

// ── Text measurement ─────────────────────────────────────────────

function measureText(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}

/** Calculate how many rows the avatar grid needs. */
function avatarGridRows(count: number): number {
  return Math.ceil(count / MINI_AVATAR_MAX_COLS);
}

/** Width needed for the avatar grid. */
function avatarGridWidth(count: number): number {
  const cols = Math.min(count, MINI_AVATAR_MAX_COLS);
  return cols * (MINI_AVATAR_SIZE + MINI_AVATAR_GAP) - MINI_AVATAR_GAP + MINI_AVATAR_PADDING * 2;
}

/** Height of the avatar grid area. */
function avatarGridHeight(count: number): number {
  if (count === 0) return 0;
  const rows = avatarGridRows(count);
  return rows * (MINI_AVATAR_SIZE + MINI_AVATAR_GAP) - MINI_AVATAR_GAP + MINI_AVATAR_PADDING * 2;
}

function cardWidth(node: OrgNode): number {
  const { roleLabel: defaultRoleLabel } = getRoleInfo(node);
  const roleLabel = node.role.startsWith("×") ? node.role : defaultRoleLabel;
  const nameW = measureText(node.name, 14) + CARD_PAD_X * 2;
  const roleW = measureText(roleLabel, 11) + CARD_PAD_X * 2;
  let w = Math.max(CARD_MIN_W, Math.max(nameW, roleW));
  // Widen for avatar grid if needed
  if (node.collapsedReports && node.collapsedReports.length > 0) {
    w = Math.max(w, avatarGridWidth(node.collapsedReports.length));
  }
  return w;
}

function cardHeight(node: OrgNode): number {
  if (node.collapsedReports && node.collapsedReports.length > 0) {
    return CARD_H + avatarGridHeight(node.collapsedReports.length);
  }
  return CARD_H;
}

// ── Tree layout (top-down, centered) ─────────────────────────────

function subtreeWidth(node: OrgNode): number {
  const cw = cardWidth(node);
  if (!node.reports || node.reports.length === 0) return cw;
  const childrenW = node.reports.reduce(
    (sum, child, i) => sum + subtreeWidth(child) + (i > 0 ? GAP_X : 0),
    0,
  );
  return Math.max(cw, childrenW);
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const w = cardWidth(node);
  const sw = subtreeWidth(node);
  const cardX = x + (sw - w) / 2;

  const h = cardHeight(node);
  const layoutNode: LayoutNode = {
    node,
    x: cardX,
    y,
    width: w,
    height: h,
    children: [],
  };

  if (node.reports && node.reports.length > 0) {
    let childX = x;
    const childY = y + h + GAP_Y;
    for (let i = 0; i < node.reports.length; i++) {
      const child = node.reports[i];
      const childSW = subtreeWidth(child);
      layoutNode.children.push(layoutTree(child, childX, childY));
      childX += childSW + GAP_X;
    }
  }

  return layoutNode;
}

// ── SVG rendering ────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a colorful Twemoji inside a circle at (cx, cy) with given radius */
function renderEmojiAvatar(cx: number, cy: number, radius: number, bgFill: string, emojiSvg: string, bgStroke?: string): string {
  const emojiSize = radius * 1.3; // emoji fills most of the circle
  const emojiX = cx - emojiSize / 2;
  const emojiY = cy - emojiSize / 2;
  const stroke = bgStroke ? `stroke="${bgStroke}" stroke-width="1"` : "";
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${bgFill}" ${stroke}/>
    <svg x="${emojiX}" y="${emojiY}" width="${emojiSize}" height="${emojiSize}" viewBox="0 0 36 36">${emojiSvg}</svg>`;
}

function defaultRenderCard(ln: LayoutNode, theme: StyleTheme): string {
  // Overflow placeholder card: just shows "+N more" text, no avatar
  if (ln.node.role === "overflow") {
    const cx = ln.x + ln.width / 2;
    const cy = ln.y + ln.height / 2;
    return `<g>
      <rect x="${ln.x}" y="${ln.y}" width="${ln.width}" height="${ln.height}" rx="${theme.cardRadius}" fill="${theme.bgColor}" stroke="${theme.cardBorder}" stroke-width="1" stroke-dasharray="4,3"/>
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family="${theme.font}" font-size="13" font-weight="600" fill="${theme.roleColor}">${escapeXml(ln.node.name)}</text>
    </g>`;
  }

  const { roleLabel: defaultRoleLabel, bg, emojiSvg } = getRoleInfo(ln.node);
  // Use node.role directly when it's a collapse badge (e.g. "×15 reports")
  const roleLabel = ln.node.role.startsWith("×") ? ln.node.role : defaultRoleLabel;
  const cx = ln.x + ln.width / 2;

  const avatarCY = ln.y + 27;
  const nameY = ln.y + 66;
  const roleY = ln.y + 82;

  const filterId = `shadow-${ln.node.id}`;
  const shadowFilter = theme.cardShadow
    ? `filter="url(#${filterId})"`
    : "";
  const shadowDef = theme.cardShadow
    ? `<filter id="${filterId}" x="-4" y="-2" width="${ln.width + 8}" height="${ln.height + 6}">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="${theme.cardShadow}"/>
        <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="rgba(0,0,0,0.03)"/>
      </filter>`
    : "";

  // For dark themes without avatars, use a subtle circle
  const isLight = theme.bgColor === "#fafaf9" || theme.bgColor === "#ffffff";
  const avatarBg = isLight ? bg : "rgba(255,255,255,0.06)";
  const avatarStroke = isLight ? undefined : "rgba(255,255,255,0.08)";

  // Render collapsed avatar grid if this node has hidden reports
  let avatarGridSvg = "";
  const collapsed = ln.node.collapsedReports;
  if (collapsed && collapsed.length > 0) {
    const gridTop = ln.y + CARD_H + MINI_AVATAR_PADDING;
    const cols = Math.min(collapsed.length, MINI_AVATAR_MAX_COLS);
    const gridTotalW = cols * (MINI_AVATAR_SIZE + MINI_AVATAR_GAP) - MINI_AVATAR_GAP;
    const gridStartX = ln.x + (ln.width - gridTotalW) / 2;

    for (let i = 0; i < collapsed.length; i++) {
      const col = i % MINI_AVATAR_MAX_COLS;
      const row = Math.floor(i / MINI_AVATAR_MAX_COLS);
      const dotCx = gridStartX + col * (MINI_AVATAR_SIZE + MINI_AVATAR_GAP) + MINI_AVATAR_SIZE / 2;
      const dotCy = gridTop + row * (MINI_AVATAR_SIZE + MINI_AVATAR_GAP) + MINI_AVATAR_SIZE / 2;
      const { bg: dotBg } = getRoleInfo(collapsed[i]);
      const dotFill = isLight ? dotBg : "rgba(255,255,255,0.1)";
      avatarGridSvg += `<circle cx="${dotCx}" cy="${dotCy}" r="${MINI_AVATAR_SIZE / 2}" fill="${dotFill}" stroke="${theme.cardBorder}" stroke-width="0.5"/>`;
    }
  }

  return `<g>
    ${shadowDef}
    <rect x="${ln.x}" y="${ln.y}" width="${ln.width}" height="${ln.height}" rx="${theme.cardRadius}" fill="${theme.cardBg}" stroke="${theme.cardBorder}" stroke-width="1" ${shadowFilter}/>
    ${renderEmojiAvatar(cx, avatarCY, AVATAR_SIZE / 2, avatarBg, emojiSvg, avatarStroke)}
    <text x="${cx}" y="${nameY}" text-anchor="middle" font-family="${theme.font}" font-size="14" font-weight="600" fill="${theme.nameColor}">${escapeXml(ln.node.name)}</text>
    <text x="${cx}" y="${roleY}" text-anchor="middle" font-family="${theme.font}" font-size="11" font-weight="500" fill="${theme.roleColor}">${escapeXml(roleLabel)}</text>
    ${avatarGridSvg}
  </g>`;
}

function renderConnectors(ln: LayoutNode, theme: StyleTheme): string {
  if (ln.children.length === 0) return "";

  const parentCx = ln.x + ln.width / 2;
  const parentBottom = ln.y + ln.height;
  const midY = parentBottom + GAP_Y / 2;
  const lc = theme.lineColor;
  const lw = theme.lineWidth;

  let svg = "";
  svg += `<line x1="${parentCx}" y1="${parentBottom}" x2="${parentCx}" y2="${midY}" stroke="${lc}" stroke-width="${lw}"/>`;

  if (ln.children.length === 1) {
    const childCx = ln.children[0].x + ln.children[0].width / 2;
    svg += `<line x1="${childCx}" y1="${midY}" x2="${childCx}" y2="${ln.children[0].y}" stroke="${lc}" stroke-width="${lw}"/>`;
  } else {
    const leftCx = ln.children[0].x + ln.children[0].width / 2;
    const rightCx = ln.children[ln.children.length - 1].x + ln.children[ln.children.length - 1].width / 2;
    svg += `<line x1="${leftCx}" y1="${midY}" x2="${rightCx}" y2="${midY}" stroke="${lc}" stroke-width="${lw}"/>`;

    for (const child of ln.children) {
      const childCx = child.x + child.width / 2;
      svg += `<line x1="${childCx}" y1="${midY}" x2="${childCx}" y2="${child.y}" stroke="${lc}" stroke-width="${lw}"/>`;
    }
  }

  for (const child of ln.children) {
    svg += renderConnectors(child, theme);
  }
  return svg;
}

function renderCards(ln: LayoutNode, theme: StyleTheme): string {
  const render = theme.renderCard || defaultRenderCard;
  let svg = render(ln, theme);
  for (const child of ln.children) {
    svg += renderCards(child, theme);
  }
  return svg;
}

function treeBounds(ln: LayoutNode): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = ln.x;
  let minY = ln.y;
  let maxX = ln.x + ln.width;
  let maxY = ln.y + ln.height;
  for (const child of ln.children) {
    const cb = treeBounds(child);
    minX = Math.min(minX, cb.minX);
    minY = Math.min(minY, cb.minY);
    maxX = Math.max(maxX, cb.maxX);
    maxY = Math.max(maxY, cb.maxY);
  }
  return { minX, minY, maxX, maxY };
}

// Paperclip logo: scaled icon (~16px) + wordmark (13px), vertically centered
const PAPERCLIP_LOGO_SVG = `<g>
  <g transform="scale(0.72)" transform-origin="0 0">
    <path stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" d="m18 4-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>
  </g>
  <text x="22" y="11.5" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="600" fill="currentColor">Paperclip</text>
</g>`;

// ── Public API ───────────────────────────────────────────────────

// GitHub recommended social media preview dimensions
const TARGET_W = 1280;
const TARGET_H = 640;

export interface OrgChartOverlay {
  /** Company name displayed top-left */
  companyName?: string;
  /** Summary stats displayed bottom-right, e.g. "Agents: 5, Skills: 8" */
  stats?: string;
}

/** Count total nodes in a tree. */
function countNodes(nodes: OrgNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count += 1 + countNodes(n.reports ?? []);
  }
  return count;
}

/** Threshold: auto-collapse orgs larger than this. */
const COLLAPSE_THRESHOLD = 20;
/** Max cards that can fit across the 1280px image. */
const MAX_LEVEL_WIDTH = 8;
/** Max children shown per parent before truncation with "and N more". */
const MAX_CHILDREN_SHOWN = 6;

/** Flatten all descendants of a node into a single list. */
function flattenDescendants(nodes: OrgNode[]): OrgNode[] {
  const result: OrgNode[] = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...flattenDescendants(n.reports ?? []));
  }
  return result;
}

/** Collect all nodes at a given depth in the tree. */
function nodesAtDepth(nodes: OrgNode[], depth: number): OrgNode[] {
  if (depth === 0) return nodes;
  const result: OrgNode[] = [];
  for (const n of nodes) {
    result.push(...nodesAtDepth(n.reports ?? [], depth - 1));
  }
  return result;
}

/**
 * Estimate how many cards would be shown at the next level if we expand,
 * considering truncation (each parent shows at most MAX_CHILDREN_SHOWN + 1 placeholder).
 */
function estimateNextLevelWidth(parentNodes: OrgNode[]): number {
  let total = 0;
  for (const p of parentNodes) {
    const childCount = (p.reports ?? []).length;
    if (childCount === 0) continue;
    total += Math.min(childCount, MAX_CHILDREN_SHOWN + 1); // +1 for "and N more" placeholder
  }
  return total;
}

/**
 * Collapse a node's children to avatar dots (for wide levels that can't expand).
 */
function collapseToAvatars(node: OrgNode): OrgNode {
  const childCount = countNodes(node.reports ?? []);
  if (childCount === 0) return node;
  return {
    ...node,
    role: `×${childCount} reports`,
    collapsedReports: flattenDescendants(node.reports ?? []),
    reports: [],
  };
}

/**
 * Truncate a node's children: keep first MAX_CHILDREN_SHOWN, replace rest with
 * a summary "and N more" placeholder node (rendered as a count card).
 */
function truncateChildren(node: OrgNode): OrgNode {
  const children = node.reports ?? [];
  if (children.length <= MAX_CHILDREN_SHOWN) return node;
  const kept = children.slice(0, MAX_CHILDREN_SHOWN);
  const hiddenCount = children.length - MAX_CHILDREN_SHOWN;
  const placeholder: OrgNode = {
    id: `${node.id}-more`,
    name: `+${hiddenCount} more`,
    role: "overflow",
    status: "active",
    reports: [],
  };
  return { ...node, reports: [...kept, placeholder] };
}

/**
 * Adaptive collapse: expands levels as long as they fit, truncates or collapses
 * when a level is too wide.
 */
function smartCollapseTree(roots: OrgNode[]): OrgNode[] {
  // Deep clone so we can mutate
  const clone = (nodes: OrgNode[]): OrgNode[] =>
    nodes.map((n) => ({ ...n, reports: clone(n.reports ?? []) }));
  const tree = clone(roots);

  // Walk levels from root down
  for (let depth = 0; depth < 10; depth++) {
    const parents = nodesAtDepth(tree, depth);
    const parentsWithChildren = parents.filter((p) => (p.reports ?? []).length > 0);
    if (parentsWithChildren.length === 0) break;

    const nextWidth = estimateNextLevelWidth(parentsWithChildren);
    if (nextWidth <= MAX_LEVEL_WIDTH) {
      // Next level fits with truncation — truncate oversized parents, then continue deeper
      for (const p of parentsWithChildren) {
        if ((p.reports ?? []).length > MAX_CHILDREN_SHOWN) {
          const truncated = truncateChildren(p);
          p.reports = truncated.reports;
        }
      }
      continue;
    }

    // Next level is too wide — collapse all children at this level to avatars
    for (const p of parentsWithChildren) {
      const collapsed = collapseToAvatars(p);
      p.role = collapsed.role;
      p.collapsedReports = collapsed.collapsedReports;
      p.reports = [];
    }
    break;
  }

  return tree;
}

export function renderOrgChartSvg(orgTree: OrgNode[], style: OrgChartStyle = "warmth", overlay?: OrgChartOverlay): string {
  const theme = THEMES[style] || THEMES.warmth;

  // Auto-collapse large orgs to keep the chart readable
  const totalNodes = countNodes(orgTree);
  const effectiveTree = totalNodes > COLLAPSE_THRESHOLD ? smartCollapseTree(orgTree) : orgTree;

  let root: OrgNode;
  if (effectiveTree.length === 1) {
    root = effectiveTree[0];
  } else {
    root = {
      id: "virtual-root",
      name: "Organization",
      role: "Root",
      status: "active",
      reports: effectiveTree,
    };
  }

  const layout = layoutTree(root, PADDING, PADDING + 24);
  const bounds = treeBounds(layout);

  const contentW = bounds.maxX + PADDING;
  const contentH = bounds.maxY + PADDING;

  // Scale content to fit within the fixed target dimensions
  const scale = Math.min(TARGET_W / contentW, TARGET_H / contentH, 1);
  const scaledW = contentW * scale;
  const scaledH = contentH * scale;
  // Center the scaled content within the target frame
  const offsetX = (TARGET_W - scaledW) / 2;
  const offsetY = (TARGET_H - scaledH) / 2;

  const logoX = TARGET_W - 110 - LOGO_PADDING;
  const logoY = LOGO_PADDING;

  // Optional overlay elements
  const overlayNameSvg = overlay?.companyName
    ? `<text x="${LOGO_PADDING}" y="${LOGO_PADDING + 16}" font-family="'Inter', -apple-system, BlinkMacSystemFont, sans-serif" font-size="22" font-weight="700" fill="${theme.nameColor}">${svgEscape(overlay.companyName)}</text>`
    : "";
  const overlayStatsSvg = overlay?.stats
    ? `<text x="${TARGET_W - LOGO_PADDING}" y="${TARGET_H - LOGO_PADDING}" text-anchor="end" font-family="'Inter', -apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="500" fill="${theme.roleColor}">${svgEscape(overlay.stats)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_W}" height="${TARGET_H}" viewBox="0 0 ${TARGET_W} ${TARGET_H}">
  <defs>${theme.defs(TARGET_W, TARGET_H)}</defs>
  <rect width="100%" height="100%" fill="${theme.bgColor}" rx="6"/>
  ${theme.bgExtras(TARGET_W, TARGET_H)}
  <g transform="translate(${logoX}, ${logoY})" color="${theme.watermarkColor}">
    ${PAPERCLIP_LOGO_SVG}
  </g>
  ${overlayNameSvg}
  ${overlayStatsSvg}
  <g transform="translate(${offsetX}, ${offsetY}) scale(${scale})">
    ${renderConnectors(layout, theme)}
    ${renderCards(layout, theme)}
  </g>
</svg>`;
}

function svgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function renderOrgChartPng(orgTree: OrgNode[], style: OrgChartStyle = "warmth", overlay?: OrgChartOverlay): Promise<Buffer> {
  const svg = renderOrgChartSvg(orgTree, style, overlay);
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  // Render at 2x density for retina quality, resize to exact target dimensions
  return sharp(Buffer.from(svg), { density: 144 })
    .resize(TARGET_W, TARGET_H)
    .png()
    .toBuffer();
}
