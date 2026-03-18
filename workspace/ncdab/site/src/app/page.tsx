import Link from "next/link";

const services = [
  {
    title: "BIM/Revit-modellering",
    description:
      "3D-modeller som ger full kontroll över projektet från start till mål. Vi skapar detaljerade BIM-modeller för arkitekter och entreprenörer.",
    icon: "🏗️",
  },
  {
    title: "Byggritningar",
    description:
      "Teknisk dokumentation och ritningar som uppfyller alla krav. Från konceptskisser till produktionsritningar.",
    icon: "📐",
  },
  {
    title: "Projektledning",
    description:
      "Professionell samordning av byggprojekt. Vi håller tidsplaner, budget och kvalitet under kontroll.",
    icon: "📋",
  },
  {
    title: "Drönardokumentation",
    description:
      "Flygfotografering och inspektioner med drönare. Effektiv dokumentation av byggarbetsplatser och framsteg.",
    icon: "🚁",
  },
];

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="bg-primary-500 text-white">
        <div className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-32">
          <div className="max-w-2xl">
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Byggkonsulter ni kan lita&nbsp;på
            </h1>
            <p className="mt-6 text-lg leading-8 text-primary-100">
              NCD AB erbjuder BIM-modellering, byggritningar, projektledning och
              drönardokumentation. Vi hjälper er genom hela byggprocessen — från
              idé till färdigt projekt.
            </p>
            <div className="mt-10 flex gap-x-4">
              <Link
                href="/kontakt"
                className="rounded-md bg-accent-500 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-accent-600 transition-colors"
              >
                Kontakta oss
              </Link>
              <Link
                href="/tjanster"
                className="rounded-md bg-white/10 px-5 py-3 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
              >
                Våra tjänster
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Services overview */}
      <section className="py-20 lg:py-28">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-steel-800 sm:text-4xl">
              Våra tjänster
            </h2>
            <p className="mt-4 text-lg text-steel-500">
              Helhetslösningar för bygg- och fastighetsprojekt
            </p>
          </div>
          <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {services.map((service) => (
              <div
                key={service.title}
                className="rounded-xl border border-steel-200 p-6 hover:shadow-lg transition-shadow"
              >
                <div className="text-3xl">{service.icon}</div>
                <h3 className="mt-4 text-lg font-semibold text-steel-800">
                  {service.title}
                </h3>
                <p className="mt-2 text-sm text-steel-500 leading-6">
                  {service.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-steel-50 py-16">
        <div className="mx-auto max-w-7xl px-6 text-center lg:px-8">
          <h2 className="text-2xl font-bold text-steel-800 sm:text-3xl">
            Redo att starta ert nästa projekt?
          </h2>
          <p className="mt-4 text-steel-500">
            Hör av er så berättar vi hur vi kan hjälpa er.
          </p>
          <Link
            href="/kontakt"
            className="mt-8 inline-block rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-primary-600 transition-colors"
          >
            Begär offert
          </Link>
        </div>
      </section>
    </>
  );
}
