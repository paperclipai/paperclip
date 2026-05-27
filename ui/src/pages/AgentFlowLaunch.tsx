import { useEffect, type ReactNode } from "react";
import { Bot, CheckCircle2, CircleAlert, Code2, ExternalLink, FileText, PlayCircle, Podcast, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

const AGENTFLOW_LAUNCH_CONFIG = {
  youtubeUrl: "https://youtube.com/shorts/lzCmoaCzar0?si=doR21imub_enSbSo",
  brabrixDevUrl: "https://dev.brabrix.com",
  spotifyUrl: "https://open.spotify.com/episode/774E9IKPOe82xZFsZN3fGM?si=9805f86100ae4818",
  githubRepoUrl: "https://github.com/brabrix/brabrix-agent",
} as const;

const SEO_TITLE = "Brabrix AgentFlow — Agentes de IA para desenvolvimento de software";
const SEO_DESCRIPTION =
  "Conheça o Brabrix AgentFlow, a experiência agentic do Brabrix Dev para transformar issues, PRDs e ideias em specs técnicas prontas para desenvolvimento.";

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeYouTubeEmbedUrl(rawUrl: string): string | null {
  if (!isHttpUrl(rawUrl)) return null;

  const parsed = new URL(rawUrl);
  const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();

  if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
    }
    if (parsed.pathname.startsWith("/shorts/")) {
      const id = parsed.pathname.replace("/shorts/", "").split("/")[0];
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
    }
    if (parsed.pathname.startsWith("/embed/")) {
      return rawUrl;
    }
  }

  if (hostname === "youtu.be") {
    const id = parsed.pathname.replace("/", "").split("/")[0];
    return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
  }

  return null;
}

function upsertMetaTag(
  selector: string,
  create: () => HTMLMetaElement,
  content: string,
): { element: HTMLMetaElement; previousContent: string | null } {
  const existing = document.head.querySelector<HTMLMetaElement>(selector);
  const element = existing ?? create();
  const previousContent = existing?.getAttribute("content") ?? null;
  element.setAttribute("content", content);
  if (!existing) document.head.appendChild(element);
  return { element, previousContent };
}

function ExternalCtaButton({
  href,
  children,
  tone = "neutral",
}: {
  href: string;
  children: ReactNode;
  tone?: "primary" | "neutral" | "subtle";
}) {
  const enabled = isHttpUrl(href);
  const baseClassName =
    "w-full rounded-xl px-4 py-3 text-sm transition-colors md:w-auto !shadow-none focus-visible:!ring-cyan-300/40 focus-visible:!border-cyan-200/60";
  const toneClassName =
    tone === "primary"
      ? "border border-cyan-300/50 bg-gradient-to-r from-cyan-500 to-blue-500 !text-white hover:from-cyan-400 hover:to-blue-400 hover:!text-white"
      : tone === "subtle"
        ? "border border-white/20 bg-transparent !text-zinc-200 hover:bg-white/10 hover:!text-zinc-100"
        : "border border-white/25 bg-white/8 !text-zinc-100 hover:bg-white/15 hover:!text-zinc-100";
  const disabledClassName = enabled ? "" : "!cursor-not-allowed !opacity-45 !text-zinc-400";
  const contentClassName = "inline-flex w-full items-center justify-between gap-3 text-left";

  if (!enabled) {
    return (
      <Button
        type="button"
        size="lg"
        variant="outline"
        disabled
        className={`${baseClassName} ${toneClassName} ${disabledClassName}`}
        aria-label="Link indisponível: configure a URL para habilitar este botão"
      >
        <span className={contentClassName}>
          <span>{children}</span>
          <ExternalLink className="size-4 opacity-80" />
        </span>
      </Button>
    );
  }

  return (
    <Button
      asChild
      type="button"
      size="lg"
      variant="outline"
      className={`${baseClassName} ${toneClassName}`}
    >
      <a href={href} target="_blank" rel="noreferrer">
        <span className={contentClassName}>
          <span>{children}</span>
          <ExternalLink className="size-4 opacity-80" />
        </span>
      </a>
    </Button>
  );
}

export function AgentFlowLaunchPage() {
  const youtubeEmbedUrl = normalizeYouTubeEmbedUrl(AGENTFLOW_LAUNCH_CONFIG.youtubeUrl);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = SEO_TITLE;

    const metaDescription = upsertMetaTag(
      'meta[name="description"]',
      () => {
        const node = document.createElement("meta");
        node.setAttribute("name", "description");
        return node;
      },
      SEO_DESCRIPTION,
    );

    const ogTitle = upsertMetaTag(
      'meta[property="og:title"]',
      () => {
        const node = document.createElement("meta");
        node.setAttribute("property", "og:title");
        return node;
      },
      SEO_TITLE,
    );

    const ogDescription = upsertMetaTag(
      'meta[property="og:description"]',
      () => {
        const node = document.createElement("meta");
        node.setAttribute("property", "og:description");
        return node;
      },
      SEO_DESCRIPTION,
    );

    const ogType = upsertMetaTag(
      'meta[property="og:type"]',
      () => {
        const node = document.createElement("meta");
        node.setAttribute("property", "og:type");
        return node;
      },
      "website",
    );

    const ogUrl = upsertMetaTag(
      'meta[property="og:url"]',
      () => {
        const node = document.createElement("meta");
        node.setAttribute("property", "og:url");
        return node;
      },
      window.location.href,
    );

    return () => {
      document.title = previousTitle;

      const restoreContent = (element: HTMLMetaElement, previousContent: string | null) => {
        if (previousContent === null) {
          element.remove();
          return;
        }
        element.setAttribute("content", previousContent);
      };

      restoreContent(metaDescription.element, metaDescription.previousContent);
      restoreContent(ogTitle.element, ogTitle.previousContent);
      restoreContent(ogDescription.element, ogDescription.previousContent);
      restoreContent(ogType.element, ogType.previousContent);
      restoreContent(ogUrl.element, ogUrl.previousContent);
    };
  }, []);

  const problemCards = [
    "IA sem contexto do projeto",
    "Issues sem critérios de aceite",
    "Backlog desconectado da execução",
    "Specs técnicas feitas manualmente",
  ];

  const features = [
    {
      title: "Gerador de Spec por Issue",
      description:
        "Transforme uma issue simples em uma especificação técnica completa, pronta para orientar o desenvolvimento.",
      icon: FileText,
    },
    {
      title: "Score de Qualidade da Issue",
      description:
        "Analise clareza, contexto técnico, critérios de aceite, testabilidade e risco de ambiguidade antes da implementação.",
      icon: CheckCircle2,
    },
    {
      title: "Agentes com Contexto",
      description:
        "Use agentes preparados para entender o projeto, o backlog, as regras e o fluxo de desenvolvimento.",
      icon: Bot,
    },
    {
      title: "Integração com Brabrix Dev",
      description:
        "Conecte planejamento, backlog e execução dentro do ecossistema Brabrix Dev.",
      icon: Code2,
    },
  ];

  const launchYear = new Date().getFullYear();

  return (
    <div
      className="h-screen overflow-y-auto bg-[#04060d] text-zinc-100"
      style={{ fontFamily: "\"Sora\", \"Plus Jakarta Sans\", \"Avenir Next\", \"Segoe UI\", sans-serif" }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/2 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-cyan-400/20 blur-[120px]" />
        <div className="absolute right-0 top-[28rem] h-[22rem] w-[22rem] rounded-full bg-blue-500/15 blur-[110px]" />
        <div className="absolute bottom-0 left-[-5rem] h-[20rem] w-[20rem] rounded-full bg-teal-500/10 blur-[95px]" />
      </div>

      <main className="relative mx-auto max-w-6xl px-6 pb-20 pt-12 md:px-10 md:pt-16">
        <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-8 md:p-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-cyan-300/10 px-3 py-1 text-xs tracking-wide text-cyan-100">
            <Sparkles className="size-3.5" />
            Brabrix AgentFlow
          </div>
          <h1 className="mt-6 max-w-3xl text-3xl font-semibold tracking-tight text-zinc-50 md:text-5xl">
            Do briefing à execução com agentes de IA.
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-relaxed text-zinc-300 md:text-lg">
            Transforme issues, PRDs e ideias em specs técnicas prontas para desenvolvimento, com agentes de IA
            conectados ao fluxo do Brabrix Dev.
          </p>
          <div className="mt-8 flex flex-col gap-3 md:flex-row md:flex-wrap">
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.youtubeUrl} tone="primary">
              <span className="inline-flex items-center gap-2">
                <PlayCircle className="size-4" />
                Assistir lançamento no YouTube
              </span>
            </ExternalCtaButton>
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.brabrixDevUrl} tone="neutral">
              <span>Conhecer o Brabrix Dev</span>
            </ExternalCtaButton>
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.spotifyUrl} tone="subtle">
              <span className="inline-flex items-center gap-2">
                <Podcast className="size-4" />
                Ouvir podcast no Spotify
              </span>
            </ExternalCtaButton>
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.githubRepoUrl} tone="neutral">
              <span>Instalar grátis no GitHub</span>
            </ExternalCtaButton>
          </div>
        </section>

        <section className="mt-10 rounded-3xl border border-white/10 bg-black/35 p-7 md:p-9">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">Instale grátis e rode local em minutos</h2>
          <p className="mt-3 max-w-4xl text-zinc-300">
            Repositório oficial: <span className="font-medium text-zinc-100">brabrix/brabrix-agent</span>. Clone, instale
            dependências e suba o ambiente local com os scripts prontos do projeto.
          </p>
          <div className="mt-6 flex flex-col gap-3 md:flex-row md:flex-wrap">
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.githubRepoUrl} tone="primary">
              <span>Abrir repositório no GitHub</span>
            </ExternalCtaButton>
          </div>
          <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-[#070b14] p-4">
            <pre className="font-mono text-xs leading-relaxed text-zinc-200 md:text-sm">
              <code>{`# Quickstart dev (local)
git clone https://github.com/brabrix/brabrix-agent.git
cd brabrix-agent
pnpm install
./scripts/brabrix-up.sh

# Acesse: http://127.0.0.1:3101
# Para parar: ./scripts/kill-dev.sh`}</code>
            </pre>
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">Assista ao lançamento</h2>
          <p className="mt-3 max-w-3xl text-zinc-300">
            Veja em poucos minutos como o Brabrix AgentFlow conecta contexto, backlog e execução em um fluxo agentic.
          </p>
          <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-2">
            {youtubeEmbedUrl ? (
              <div className="aspect-video w-full overflow-hidden rounded-xl">
                <iframe
                  className="h-full w-full"
                  src={youtubeEmbedUrl}
                  title="Lançamento Brabrix AgentFlow"
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              </div>
            ) : (
              <div className="flex min-h-60 items-center justify-center rounded-xl border border-dashed border-white/15 px-6 py-10 text-center text-zinc-300">
                <div>
                  <CircleAlert className="mx-auto mb-3 size-5 text-amber-300" />
                  Configure o link do YouTube em <code className="text-cyan-200">AGENTFLOW_LAUNCH_CONFIG.youtubeUrl</code>{" "}
                  para habilitar o vídeo.
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">
            O desenvolvimento moderno está cada vez mais fragmentado
          </h2>
          <p className="mt-3 max-w-4xl text-zinc-300">
            PRDs ficam em documentos separados. Issues nascem incompletas. A IA perde contexto. O backlog não conversa
            com o código. E o desenvolvedor precisa juntar tudo manualmente antes de começar a implementar.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {problemCards.map((item) => (
              <article
                key={item}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
              >
                <p className="font-medium">{item}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-16 rounded-3xl border border-cyan-300/20 bg-cyan-400/[0.04] p-7 md:p-10">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">O AgentFlow conecta tudo em um fluxo agentic</h2>
          <p className="mt-3 max-w-4xl text-zinc-200/90">
            Com o Brabrix AgentFlow, cada issue pode virar uma spec técnica estruturada, com contexto, regras de
            negócio, critérios de aceite, plano de testes e checklist de implementação.
          </p>
          <div className="mt-6 grid gap-3 rounded-2xl border border-white/10 bg-black/30 p-5 md:grid-cols-6">
            {["Briefing", "PRD", "Spec Técnica", "Backlog", "Issues", "Código"].map((step, index) => (
              <div key={step} className="flex items-center gap-2 text-sm text-zinc-200">
                <span className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full border border-cyan-200/25 bg-cyan-300/10 text-xs text-cyan-100">
                  {index + 1}
                </span>
                <span>{step}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">Features</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {features.map((feature) => (
              <article
                key={feature.title}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-[0_14px_40px_-28px_rgba(34,211,238,0.5)]"
              >
                <feature.icon className="size-5 text-cyan-200" />
                <h3 className="mt-4 text-lg font-semibold text-zinc-50">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">{feature.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-16 rounded-3xl border border-white/10 bg-white/[0.025] p-8 md:p-10">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">Ouça também o episódio especial no Spotify</h2>
          <p className="mt-3 max-w-4xl text-zinc-300">
            No podcast de lançamento, explicamos a visão por trás do Brabrix AgentFlow, o papel dos agentes de IA no
            desenvolvimento de software e como essa experiência se conecta ao futuro do Brabrix Dev.
          </p>
          <div className="mt-6">
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.spotifyUrl} tone="primary">
              <span>Ouvir no Spotify</span>
            </ExternalCtaButton>
          </div>
        </section>

        <section className="mt-16 rounded-3xl border border-cyan-200/25 bg-gradient-to-r from-cyan-400/15 via-blue-500/15 to-slate-700/20 p-8 md:p-10">
          <h2 className="text-2xl font-semibold text-zinc-50 md:text-3xl">Entre na nova fase do desenvolvimento com IA</h2>
          <p className="mt-3 max-w-4xl text-zinc-200/90">
            O Brabrix AgentFlow é o próximo passo do Brabrix Dev: menos contexto perdido, menos issue mal escrita e
            mais velocidade para transformar ideia em execução.
          </p>
          <div className="mt-7 flex flex-col gap-3 md:flex-row md:flex-wrap">
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.brabrixDevUrl} tone="primary">
              <span>Conhecer o Brabrix Dev</span>
            </ExternalCtaButton>
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.youtubeUrl} tone="neutral">
              <span>Assistir ao vídeo</span>
            </ExternalCtaButton>
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.spotifyUrl} tone="subtle">
              <span>Ouvir podcast</span>
            </ExternalCtaButton>
            <ExternalCtaButton href={AGENTFLOW_LAUNCH_CONFIG.githubRepoUrl} tone="neutral">
              <span>Instalar grátis no GitHub</span>
            </ExternalCtaButton>
          </div>
        </section>

        <footer className="mt-12 border-t border-white/10 py-6 text-xs text-zinc-500">
          Brabrix AgentFlow · {launchYear}
        </footer>
      </main>
    </div>
  );
}
