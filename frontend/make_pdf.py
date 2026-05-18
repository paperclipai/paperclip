from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm, cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import Flowable

OUTPUT = r"C:\Users\Alejandro\paperclip\frontend\resumen-proyecto.pdf"

# ── Colour palette ────────────────────────────────────────────────────────────
DARK_HEADER   = colors.HexColor("#1a1f2e")   # deep navy
ACCENT        = colors.HexColor("#2d6cdf")   # bright blue
ACCENT_LIGHT  = colors.HexColor("#e8f0fd")   # very light blue tint
TEXT_DARK     = colors.HexColor("#1c1c1e")
TEXT_MED      = colors.HexColor("#3a3a3c")
CODE_BG       = colors.HexColor("#f0f2f5")
TABLE_HEAD    = colors.HexColor("#2d6cdf")
TABLE_ALT     = colors.HexColor("#f6f8ff")
WHITE         = colors.white
RULE_COLOR    = colors.HexColor("#c8d4f0")


# ── Dark header banner (drawn with canvas) ────────────────────────────────────
class HeaderBanner(Flowable):
    def __init__(self, width, height=60*mm):
        Flowable.__init__(self)
        self.banner_width  = width
        self.banner_height = height

    def wrap(self, *_):
        return self.banner_width, self.banner_height

    def draw(self):
        c = self.canv
        w, h = self.banner_width, self.banner_height

        # Background rectangle
        c.setFillColor(DARK_HEADER)
        c.rect(0, 0, w, h, fill=1, stroke=0)

        # Accent stripe at bottom
        c.setFillColor(ACCENT)
        c.rect(0, 0, w, 4, fill=1, stroke=0)

        # Title
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 28)
        c.drawCentredString(w / 2, h - 28*mm, "CONTENT-O-MATIC 3000")

        # Subtitle
        c.setFont("Helvetica", 11)
        c.setFillColor(colors.HexColor("#a8bde8"))
        c.drawCentredString(w / 2, h - 40*mm,
            "Resumen del Proyecto  —  Canal @historias.en.sombra")

        # Date tag top-right
        c.setFont("Helvetica", 8)
        c.setFillColor(colors.HexColor("#6b80b0"))
        c.drawRightString(w - 6*mm, h - 8*mm, "Abril 2026")


# ── Page template (adds page numbers) ────────────────────────────────────────
def on_page(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(TEXT_MED)
    canvas.drawCentredString(w / 2, 10*mm,
        f"CONTENT-O-MATIC 3000  |  Página {doc.page}")
    # Footer rule
    canvas.setStrokeColor(RULE_COLOR)
    canvas.setLineWidth(0.5)
    canvas.line(20*mm, 14*mm, w - 20*mm, 14*mm)
    canvas.restoreState()


# ── Style helpers ─────────────────────────────────────────────────────────────
def build_styles():
    base = getSampleStyleSheet()

    section_header = ParagraphStyle(
        "SectionHeader",
        fontName="Helvetica-Bold",
        fontSize=12,
        textColor=WHITE,
        backColor=ACCENT,
        spaceBefore=14,
        spaceAfter=6,
        leftIndent=0,
        rightIndent=0,
        borderPad=(4, 6, 4, 6),   # top right bottom left
        leading=16,
    )

    body = ParagraphStyle(
        "Body",
        fontName="Helvetica",
        fontSize=10,
        textColor=TEXT_DARK,
        leading=15,
        spaceBefore=2,
        spaceAfter=2,
    )

    bullet = ParagraphStyle(
        "Bullet",
        parent=body,
        leftIndent=14,
        bulletIndent=4,
        spaceBefore=1,
        spaceAfter=1,
    )

    numbered = ParagraphStyle(
        "Numbered",
        parent=body,
        leftIndent=18,
        bulletIndent=4,
        spaceBefore=1,
        spaceAfter=1,
    )

    code_inline = ParagraphStyle(
        "CodeInline",
        fontName="Courier",
        fontSize=9,
        textColor=TEXT_DARK,
        backColor=CODE_BG,
        leading=14,
        leftIndent=14,
        bulletIndent=4,
        spaceBefore=1,
        spaceAfter=1,
    )

    return {
        "header":   section_header,
        "body":     body,
        "bullet":   bullet,
        "numbered": numbered,
        "code":     code_inline,
    }


def section(title, styles):
    """Return a section header paragraph."""
    return Paragraph(f"&nbsp; {title}", styles["header"])


def bullet_item(text, styles, code=False):
    s = styles["code"] if code else styles["bullet"]
    return Paragraph(f"<bullet>&bull;</bullet> {text}", s)


def numbered_item(num, text, styles):
    return Paragraph(f"<bullet>{num}.</bullet> {text}", styles["numbered"])


# ── Build document ────────────────────────────────────────────────────────────
def build_pdf():
    doc = SimpleDocTemplate(
        OUTPUT,
        pagesize=A4,
        leftMargin=20*mm,
        rightMargin=20*mm,
        topMargin=14*mm,
        bottomMargin=20*mm,
        title="CONTENT-O-MATIC 3000 — Resumen del Proyecto",
        author="Alejandro",
    )

    styles = build_styles()
    usable_w = A4[0] - 40*mm   # usable page width

    story = []

    # ── Banner ────────────────────────────────────────────────────────────────
    story.append(HeaderBanner(usable_w, height=58*mm))
    story.append(Spacer(1, 8*mm))

    # ── SECTION 1 ─────────────────────────────────────────────────────────────
    story.append(section("1. QUÉ ES ESTE PROYECTO", styles))
    story.append(Spacer(1, 2*mm))
    story.append(Paragraph(
        "Una plataforma de automatización de contenido para TikTok, desplegada en "
        "<b>Railway</b>, que usa agentes de IA para generar el paquete completo de "
        "contenido semanal para el canal <b>@historias.en.sombra</b> — historias de "
        "traición, engaño e infidelidad en español para audiencia latina 18-35 años.",
        styles["body"]
    ))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 2 ─────────────────────────────────────────────────────────────
    story.append(section("2. ARQUITECTURA", styles))
    story.append(Spacer(1, 2*mm))
    arch_items = [
        ("<b>Plataforma:</b> Paperclip (open-source AI agent platform) desplegada en Railway", False),
        ("<b>Base de datos:</b> PostgreSQL (Railway addon)", False),
        ("<b>URL:</b> spirited-charm-production.up.railway.app", False),
        ("<b>LLMs:</b> OpenRouter API con modelos gratuitos (llama-3.3-70b, gemma-3-27b, gpt-oss-120b, mistral-7b)", False),
        ("<b>Memoria:</b> Sistema de archivos /tmp/agent_memory en Railway", False),
    ]
    for text, code in arch_items:
        story.append(bullet_item(text, styles, code=code))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 3 — Table ─────────────────────────────────────────────────────
    story.append(section("3. AGENTES CONSTRUIDOS (5 activos)", styles))
    story.append(Spacer(1, 2*mm))

    table_data = [
        ["Agente", "Función", "Archivo"],
        ["Director", "Orquestador principal, coordina los 4 sub-agentes", "director.py"],
        ["Deep Search", "Busca tendencias virales en Reddit y TikTok hispano", "deep_search.py"],
        ["Channel Analyzer", "Analiza competencia y encuentra oportunidades", "channel_analyzer.py"],
        ["Storytelling Designer", "Escribe guiones completos palabra por palabra", "storytelling.py"],
        ["Prompt Generator", "Genera prompts para Midjourney/DALL-E", "prompt_generator.py"],
    ]

    col_widths = [42*mm, 100*mm, 38*mm]

    table_style = TableStyle([
        # Header row
        ("BACKGROUND",  (0, 0), (-1, 0),  TABLE_HEAD),
        ("TEXTCOLOR",   (0, 0), (-1, 0),  WHITE),
        ("FONTNAME",    (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1, 0),  10),
        ("ALIGN",       (0, 0), (-1, 0),  "CENTER"),
        # Data rows
        ("FONTNAME",    (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",    (0, 1), (-1, -1), 9),
        ("TEXTCOLOR",   (0, 1), (-1, -1), TEXT_DARK),
        ("FONTNAME",    (0, 1), (0, -1),  "Helvetica-Bold"),  # first col bold
        ("FONTNAME",    (2, 1), (2, -1),  "Courier"),         # file col mono
        # Alternating rows
        ("BACKGROUND",  (0, 2), (-1, 2),  TABLE_ALT),
        ("BACKGROUND",  (0, 4), (-1, 4),  TABLE_ALT),
        # Grid
        ("GRID",        (0, 0), (-1, -1), 0.5, RULE_COLOR),
        ("ROWBACKGROUND", (0, 0), (-1, 0), TABLE_HEAD),
        # Padding
        ("TOPPADDING",  (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN",      (0, 0), (-1, -1), "MIDDLE"),
    ])

    t = Table(table_data, colWidths=col_widths)
    t.setStyle(table_style)
    story.append(t)
    story.append(Spacer(1, 4*mm))

    # ── SECTION 4 ─────────────────────────────────────────────────────────────
    story.append(section("4. FLUJO DE TRABAJO", styles))
    story.append(Spacer(1, 2*mm))
    workflow = [
        "Usuario crea un issue en Paperclip con el objetivo",
        "Director se activa automáticamente",
        "Lanza Deep Search &rarr; busca tendencias virales",
        "Lanza Channel Analyzer &rarr; analiza competencia",
        "Lanza Storytelling &rarr; crea el guión basado en tendencias",
        "Lanza Prompt Generator &rarr; genera prompts de imágenes",
        "Director sintetiza todo en un paquete ejecutivo",
        "Resultado aparece en el chat del issue (inbox)",
        "Issue se cierra automáticamente",
    ]
    for i, step in enumerate(workflow, 1):
        story.append(numbered_item(i, step, styles))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 5 ─────────────────────────────────────────────────────────────
    story.append(section("5. PROBLEMAS RESUELTOS", styles))
    story.append(Spacer(1, 2*mm))
    problems = [
        "<b>Rate limits OpenRouter:</b> Sistema de fallback con 4 modelos en cascada",
        "<b>Autenticación API:</b> JWT generado en Python usando BETTER_AUTH_SECRET del servidor",
        "<b>PAPERCLIP_ISSUE_ID vacío:</b> Modificado el process adapter (execute.ts) para inyectar el issue ID y el JWT token en el entorno del subproceso",
        "<b>Memory path:</b> Ruta adaptada para Linux (/tmp) vs Windows (Obsidian Vault)",
        "<b>Sub-agentes crasheando:</b> save() hecha no-fatal, eliminados except urllib sin import",
        "<b>Acceso de Gabo:</b> Invitación generada vía API del navegador",
    ]
    for p in problems:
        story.append(bullet_item(p, styles))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 6 ─────────────────────────────────────────────────────────────
    story.append(section("6. FIXES TÉCNICOS CLAVE", styles))
    story.append(Spacer(1, 2*mm))
    fixes = [
        ("server/src/adapters/process/execute.ts", "Inyecta PAPERCLIP_RUN_ID, PAPERCLIP_ISSUE_ID, PAPERCLIP_API_KEY desde el contexto de ejecución"),
        ("agents/memory.py", "Detecta OS para usar ruta correcta"),
        ("agents/director.py", "Genera JWT con HMAC-SHA256, cierra issue PRIMERO luego postea comentario"),
        ("Dockerfile", "Cambiado --frozen-lockfile a --no-frozen-lockfile"),
    ]
    for filename, desc in fixes:
        story.append(bullet_item(
            f"<font name='Courier' size='9' color='#1a4fa0'>{filename}</font>: {desc}",
            styles
        ))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 7 ─────────────────────────────────────────────────────────────
    story.append(section("7. AGENTES PENDIENTES (próxima fase)", styles))
    story.append(Spacer(1, 2*mm))
    pending = [
        (6, "Agente de Imágenes — Higgsfield API para thumbnails reales"),
        (7, "Agente de Voz — ElevenLabs API para audio del guión"),
        (8, "Agente de Subtítulos — genera archivo .srt"),
        (9, "Dropshipping Scout — busca productos ganadores"),
    ]
    for num, text in pending:
        story.append(numbered_item(num, text, styles))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 8 ─────────────────────────────────────────────────────────────
    story.append(section("8. FRONTEND EN DESARROLLO", styles))
    story.append(Spacer(1, 2*mm))
    frontend = [
        "<b>Estilo:</b> pixel art / Futurama (robots y humanos conviviendo)",
        "<b>Stack:</b> HTML/CSS/JS puro (single file)",
        "<b>Funcionalidad:</b> botón único &rarr; resultado completo sin ver el proceso técnico",
        "<b>Pendiente:</b> conectar con Paperclip API + integrar imagen pixel art generada",
    ]
    for f in frontend:
        story.append(bullet_item(f, styles))
    story.append(Spacer(1, 4*mm))

    # ── SECTION 9 ─────────────────────────────────────────────────────────────
    story.append(section("9. USUARIOS", styles))
    story.append(Spacer(1, 2*mm))
    users_data = [
        ["Usuario", "Rol"],
        ["Alejandro", "Admin / CEO de la empresa en Paperclip"],
        ["Gabo", "Usuario invitado — creador del canal @historias.en.sombra"],
    ]
    users_style = TableStyle([
        ("BACKGROUND",   (0, 0), (-1, 0),  TABLE_HEAD),
        ("TEXTCOLOR",    (0, 0), (-1, 0),  WHITE),
        ("FONTNAME",     (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",     (0, 0), (-1, 0),  10),
        ("ALIGN",        (0, 0), (-1, 0),  "CENTER"),
        ("FONTNAME",     (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",     (0, 1), (-1, -1), 9),
        ("FONTNAME",     (0, 1), (0, -1),  "Helvetica-Bold"),
        ("BACKGROUND",   (0, 2), (-1, 2),  TABLE_ALT),
        ("GRID",         (0, 0), (-1, -1), 0.5, RULE_COLOR),
        ("TOPPADDING",   (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 5),
        ("LEFTPADDING",  (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN",       (0, 0), (-1, -1), "MIDDLE"),
    ])
    ut = Table(users_data, colWidths=[40*mm, 140*mm])
    ut.setStyle(users_style)
    story.append(ut)
    story.append(Spacer(1, 4*mm))

    # ── SECTION 10 ────────────────────────────────────────────────────────────
    story.append(section("10. PRÓXIMOS PASOS", styles))
    story.append(Spacer(1, 2*mm))
    next_steps = [
        "Configurar Routine semanal automática (sin intervención manual)",
        "Construir agentes 6, 7, 8, 9",
        "Completar y desplegar el frontend",
        "Integrar Higgsfield API para generación de imágenes",
        "Integrar ElevenLabs para generación de voz",
        "Adaptar la plataforma para dropshipping de Gabo",
    ]
    for i, step in enumerate(next_steps, 1):
        story.append(numbered_item(i, step, styles))
    story.append(Spacer(1, 8*mm))

    # ── Footer rule + tagline ─────────────────────────────────────────────────
    story.append(HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=4))
    story.append(Paragraph(
        "<font color='#2d6cdf'><b>CONTENT-O-MATIC 3000</b></font>  "
        "<font color='#6b7280'>— Plataforma de IA para creadores de contenido</font>",
        ParagraphStyle("footer_tag", fontName="Helvetica", fontSize=8,
                       textColor=TEXT_MED, alignment=TA_CENTER)
    ))

    # ── Build ─────────────────────────────────────────────────────────────────
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"PDF saved: {OUTPUT}")


if __name__ == "__main__":
    build_pdf()
