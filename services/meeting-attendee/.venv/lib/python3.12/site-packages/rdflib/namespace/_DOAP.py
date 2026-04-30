from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class DOAP(DefinedNamespace):
    """
    Description of a Project (DOAP) vocabulary

    The Description of a Project (DOAP) vocabulary, described using W3C RDF Schema and the Web Ontology Language.

    Generated from: http://usefulinc.com/ns/doap
    Date: 2024-08-01 13:03:22.175167
    """

    _NS = Namespace("http://usefulinc.com/ns/doap#")

    _fail = True

    ArchRepository: URIRef  # GNU Arch source code repository. Dépôt GNU Arch du code source. Repositorio GNU Arch del código fuente. GNU Arch Quellcode-Versionierungssystem. Úložiště zdrojových kódů GNU Arch. Repositório GNU Arch do código fonte.
    BKRepository: URIRef  # BitKeeper source code repository. Dépôt BitKeeper du code source. Repositorio BitKeeper del código fuente. BitKeeper Quellcode-Versionierungssystem. Úložiště zdrojových kódů BitKeeper. Repositório BitKeeper do código fonte.
    BazaarBranch: (
        URIRef  # Bazaar source code branch. Código fonte da ramificação Bazaar.
    )
    CVSRepository: URIRef  # CVS source code repository. Dépôt CVS du code source. Repositorio CVS del código fuente. CVS Quellcode-Versionierungssystem. Úložiště zdrojových kódů CVS. Repositório CVS do código fonte.
    DarcsRepository: URIRef  # darcs source code repository. Dépôt darcs du code source. Repositorio darcs del código fuente. Repositório darcs do código fonte.
    GitBranch: URIRef  # Git source code branch. Código fonte da ramificação Git.
    GitRepository: URIRef  # Git source code repository. Dépôt Git du code source. Repositorio Git del código fuente. Git Quellcode-Versionierungssystem. Úložiště zdrojových kódů Git. Repositório Git do código fonte.
    HgRepository: URIRef  # Mercurial source code repository. Repositório Mercurial do código fonte.
    Project: URIRef  # A project. Un projet. Un proyecto. Ein Projekt. Projekt. Projeto.
    Repository: URIRef  # Source code repository. Dépôt du code source. Repositorio del código fuente. Quellcode-Versionierungssystem. Úložiště zdrojových kódů. Repositório do código fonte.
    SVNRepository: URIRef  # Subversion source code repository. Dépôt Subversion du code source. Repositorio Subversion del código fuente. Subversion Quellcode-Versionierungssystem. Úložiště zdrojových kódů Subversion. Repositório Subversion do código fonte.
    Specification: URIRef  # A specification of a system's aspects, technical or otherwise. A especificação de aspetos, técnicas ou outros do sistema.
    Version: URIRef  # Version information of a project release. Détails sur une version d'une release d'un projet. Información sobre la versión de un release del proyecto. Versionsinformation eines Projekt Releases. Informace o uvolněné verzi projektu. Informação sobre a versão do projeto lançado.
    audience: (
        URIRef  # Description of target user base Descrição do utilizador base alvo
    )
    blog: URIRef  # URI of a blog related to a project URI de um blog relacionado com um projeto
    browse: URIRef  # Web browser interface to repository. Interface web au dépôt. Interface web del repositorio. Web-Browser Interface für das Repository. Webové rozhraní pro prohlížení úložiště. Interface web do repositório.
    category: URIRef  # A category of project. Une catégorie de projet. Una categoría de proyecto. Eine Kategorie eines Projektes. Kategorie projektu. Uma categoría de projeto.
    created: URIRef  # Date when something was created, in YYYY-MM-DD form. e.g. 2004-04-05 Date à laquelle a été créé quelque chose, au format AAAA-MM-JJ (par ex. 2004-04-05) Fecha en la que algo fue creado, en formato AAAA-MM-DD. e.g. 2004-04-05 Erstellungsdatum von Irgendwas, angegeben im YYYY-MM-DD Format, z.B. 2004-04-05. Datum, kdy bylo něco vytvořeno ve formátu RRRR-MM-DD, např. 2004-04-05 Data em que algo foi criado, no formato AAAA-MM-DD. e.g. 2004-04-05
    description: URIRef  # Plain text description of a project, of 2-4 sentences in length. Texte descriptif d'un projet, long de 2 à 4 phrases. Descripción en texto plano de un proyecto, de 2 a 4 enunciados de longitud. Beschreibung eines Projekts als einfacher Text mit der Länge von 2 bis 4 Sätzen. Čistě textový, 2 až 4 věty dlouhý popis projektu. Descrição de um projeto em texto apenas, com 2 a 4 frases de comprimento.
    developer: URIRef  # Developer of software for the project. Développeur pour le projet. Desarrollador de software para el proyecto. Software-Entwickler für das Projekt. Vývojář softwaru projektu. Programador de software para o projeto.
    documentation: (
        URIRef  # Documentation of the project. Aide pour l’utilisation de ce projet.
    )
    documenter: URIRef  # Contributor of documentation to the project. Collaborateur à la documentation du projet. Proveedor de documentación para el proyecto. Mitarbeiter an der Dokumentation des Projektes. Spoluautor dokumentace projektu. Contribuidor para a documentação do projeto.
    helper: URIRef  # Project contributor. Collaborateur au projet. Colaborador del proyecto. Projekt-Mitarbeiter. Spoluautor projektu. Ajudante ou colaborador do projeto.
    homepage: URIRef  # URL of a project's homepage, 		associated with exactly one project. L'URL de la page web d'un projet, 		associée avec un unique projet. El URL de la página de un proyecto, 		asociada con exactamente un proyecto. URL der Projekt-Homepage, 		verbunden mit genau einem Projekt. URL adresa domovské stránky projektu asociované s právě jedním projektem. O URL da página de um projeto, 		asociada com exactamente um projeto.
    implements: URIRef  # A specification that a project implements. Could be a standard, API or legally defined level of conformance. Uma especificação que um projeto implementa. Pode ser uma padrão, API ou um nível de conformidade definida legalmente.
    language: URIRef  # BCP47 language code a project has been translated into Código de idioma BCP47 do projeto para o qual foi traduzido
    license: URIRef  # The URI of an RDF description of the license the software is distributed under. E.g. a SPDX reference L'URI d'une description RDF de la licence sous laquelle le programme est distribué. El URI de una descripción RDF de la licencia bajo la cuál se distribuye el software. Die URI einer RDF-Beschreibung einer Lizenz unter der die Software herausgegeben wird. z.B. eine SPDX Referenz URI adresa RDF popisu licence, pod kterou je software distribuován. O URI de uma descrição RDF da licença do software sob a qual é distribuída. Ex.: referência SPDX
    location: URIRef  # Location of a repository. Emplacement d'un dépôt. lugar de un repositorio. Lokation eines Repositorys. Umístění úložiště. Localização de um repositório.
    maintainer: URIRef  # Maintainer of a project, a project leader. Développeur principal d'un projet, un meneur du projet. Desarrollador principal de un proyecto, un líder de proyecto. Hauptentwickler eines Projektes, der Projektleiter Správce projektu, vedoucí projektu. Programador principal de um projeto, um líder de projeto.
    module: URIRef  # Module name of a Subversion, CVS, BitKeeper or Arch repository. Nom du module d'un dépôt Subversion, CVS, BitKeeper ou Arch. Nombre del módulo de un repositorio Subversion, CVS, BitKeeper o Arch. Modul-Name eines Subversion, CVS, BitKeeper oder Arch Repositorys. Jméno modulu v CVS, BitKeeper nebo Arch úložišti. Nome do módulo de um repositório Subversion, CVS, BitKeeper ou Arch.
    name: URIRef  # A name of something. Le nom de quelque chose. El nombre de algo. Der Name von Irgendwas Jméno něčeho. O nome de alguma coisa.
    os: URIRef  # Operating system that a project is limited to.  Omit this property if the project is not OS-specific. Système d'exploitation auquel est limité le projet. Omettez cette propriété si le 		projet n'est pas limité à un système d'exploitation. Sistema opertivo al cuál está limitado el proyecto.  Omita esta propiedad si el proyecto no es específico 		de un sistema opertaivo en particular. Betriebssystem auf dem das Projekt eingesetzt werden kann. Diese Eigenschaft kann ausgelassen werden, wenn das Projekt nicht BS-spezifisch ist. Operační systém, na jehož použití je projekt limitován. Vynechejte tuto vlastnost, pokud je projekt nezávislý na operačním systému. Sistema operativo a que o projeto está limitado. Omita esta propriedade se o projeto não é condicionado pelo SO usado.
    platform: URIRef  # Indicator of software platform (non-OS specific), e.g. Java, Firefox, ECMA CLR Indicador da plataforma do software (não específico a nenhum SO), ex.: Java, Firefox, ECMA CLR
    release: URIRef  # A project release. Une release (révision) d'un projet. Un release (versión) de un proyecto. Ein Release (Version) eines Projekts. Relase (verze) projektu. A publicação de um projeto.
    repository: URIRef  # Source code repository. Dépôt du code source. Repositorio del código fuente. Quellcode-Versionierungssystem. Úložiště zdrojových kódů. Repositório do código fonte.
    repositoryOf: URIRef  # The project that uses a repository.
    revision: URIRef  # Revision identifier of a software release. Identifiant de révision d'une release du programme. Indentificador de la versión de un release de software. Versionsidentifikator eines Software-Releases. Identifikátor zpřístupněné revize softwaru. Identificador do lançamento da revisão do software.
    screenshots: URIRef  # Web page with screenshots of project. Page web avec des captures d'écran du projet. Página web con capturas de pantalla del proyecto. Web-Seite mit Screenshots eines Projektes. Webová stránka projektu se snímky obrazovky. Página web com as capturas de ecrãn do projeto.
    shortdesc: URIRef  # Short (8 or 9 words) plain text description of a project. Texte descriptif concis (8 ou 9 mots) d'un projet. Descripción corta (8 o 9 palabras) en texto plano de un proyecto. Kurzbeschreibung (8 oder 9 Wörter) eines Projekts als einfacher Text. Krátký (8 nebo 9 slov) čistě textový popis projektu. Descrição curta (com 8 ou 9 palavras) de um projeto em texto apenas.
    tester: URIRef  # A tester or other quality control contributor. Un testeur ou un collaborateur au contrôle qualité. Un tester u otro proveedor de control de calidad. Ein Tester oder anderer Mitarbeiter der Qualitätskontrolle. Tester nebo jiný spoluautor kontrolující kvalitu. Um controlador ou outro contribuidor para o controlo de qualidade.
    translator: URIRef  # Contributor of translations to the project. Collaborateur à la traduction du projet. Proveedor de traducciones al proyecto. Mitarbeiter an den Übersetzungen des Projektes. Spoluautor překladu projektu. Contribuidor das traduções para o projeto.
    vendor: URIRef  # Vendor organization: commercial, free or otherwise
    wiki: URIRef  # URL of Wiki for collaborative discussion of project. L'URL du Wiki pour la discussion collaborative sur le projet. URL del Wiki para discusión colaborativa del proyecto. Wiki-URL für die kollaborative Dikussion eines Projektes. URL adresa wiki projektu pro společné diskuse. URL da Wiki para discussão em grupo do projeto.

    # Valid non-python identifiers
    _extras = [
        "anon-root",  # Repository for anonymous access. Dépôt pour accès anonyme. Repositorio para acceso anónimo. Repository für anonymen Zugriff Úložiště pro anonymní přístup. Repositório para acesso anónimo.
        "bug-database",  # Bug tracker for a project. Suivi des bugs pour un projet. Bug tracker para un proyecto. Fehlerdatenbank eines Projektes. Správa chyb projektu. Bug tracker para um projeto.
        "developer-forum",  # A forum or community for developers of this project.
        "download-mirror",  # Mirror of software download web page. Miroir de la page de téléchargement du programme. Mirror de la página web de descarga. Spiegel der Seite von die Projekt-Software heruntergeladen werden kann. Zrcadlo stránky pro stažení softwaru. Mirror da página web para fazer download.
        "download-page",  # Web page from which the project software can be downloaded. Page web à partir de laquelle on peut télécharger le programme. Página web de la cuál se puede bajar el software. Web-Seite von der die Projekt-Software heruntergeladen werden kann. Webová stránka, na které lze stáhnout projektový software. Página web da qual o projeto de software pode ser descarregado.
        "file-release",  # URI of download associated with this release. URI adresa stažení asociované s revizí. URI para download associado com a publicação.
        "mailing-list",  # Mailing list home page or email address. Page web de la liste de diffusion, ou adresse de courriel. Página web de la lista de correo o dirección de correo. Homepage der Mailing Liste oder E-Mail Adresse. Domovská stránka nebo e–mailová adresa e–mailové diskuse. Página web da lista de distribuição de e-mail ou dos endereços.
        "old-homepage",  # URL of a project's past homepage, 		associated with exactly one project. L'URL d'une ancienne page web d'un 		projet, associée avec un unique projet. El URL de la antigua página de un proyecto, 		asociada con exactamente un proyecto. URL der letzten Projekt-Homepage, 		verbunden mit genau einem Projekt. URL adresa předešlé domovské stránky projektu asociované s právě jedním projektem. O URL antigo da página de um projeto, 		associada com exactamente um projeto.
        "programming-language",  # Programming language a project is implemented in or intended for use with. Langage de programmation avec lequel un projet est implémenté, 		ou avec lequel il est prévu de l'utiliser. Lenguaje de programación en el que un proyecto es implementado o con el cuál pretende usarse. Programmiersprache in der ein Projekt implementiert ist oder intendiert wird zu benutzen. Programovací jazyk, ve kterém je projekt implementován nebo pro který je zamýšlen k použití. Linguagem de programação que o projeto usa ou é para ser utilizada.
        "security-contact",  # The Agent that should be contacted 	if security issues are found with the project.
        "security-policy",  # URL of the security policy of a project.
        "service-endpoint",  # The URI of a web service endpoint where software as a service may be accessed
        "support-forum",  # A forum or community that supports this project.
    ]
