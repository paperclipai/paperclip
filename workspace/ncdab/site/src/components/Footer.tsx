import Link from "next/link";

const services = [
  { name: "BIM/Revit-modellering", href: "/tjanster#bim" },
  { name: "Byggritningar", href: "/tjanster#ritningar" },
  { name: "Projektledning", href: "/tjanster#projektledning" },
  { name: "Drönar­dokumentation", href: "/tjanster#dronar" },
];

const company = [
  { name: "Om oss", href: "/om-oss" },
  { name: "Kontakt", href: "/kontakt" },
];

export default function Footer() {
  return (
    <footer className="bg-steel-800 text-steel-300">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {/* Brand */}
          <div>
            <span className="text-2xl font-bold text-white">
              NCD<span className="text-accent-500">AB</span>
            </span>
            <p className="mt-4 text-sm leading-6">
              Byggkonsulter med expertis inom BIM, ritningar, projektledning och
              drönardokumentation. Vi hjälper er från projektering till
              färdigställande.
            </p>
          </div>

          {/* Services */}
          <div>
            <h3 className="text-sm font-semibold text-white">Tjänster</h3>
            <ul className="mt-4 space-y-2">
              {services.map((item) => (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    className="text-sm hover:text-white transition-colors"
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-sm font-semibold text-white">Företaget</h3>
            <ul className="mt-4 space-y-2">
              {company.map((item) => (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    className="text-sm hover:text-white transition-colors"
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-white">Kontakt</h3>
              <p className="mt-2 text-sm">info@ncdab.se</p>
            </div>
          </div>
        </div>

        <div className="mt-12 border-t border-steel-700 pt-8">
          <p className="text-center text-xs text-steel-400">
            &copy; {new Date().getFullYear()} NCD AB. Alla rättigheter
            förbehållna.
          </p>
        </div>
      </div>
    </footer>
  );
}
