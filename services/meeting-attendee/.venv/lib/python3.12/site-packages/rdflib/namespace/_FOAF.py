from rdflib.namespace import DefinedNamespace, Namespace
from rdflib.term import URIRef


class FOAF(DefinedNamespace):
    """
    Friend of a Friend (FOAF) vocabulary

    The Friend of a Friend (FOAF) RDF vocabulary, described using W3C RDF Schema and the Web Ontology Language.

    Generated from: http://xmlns.com/foaf/spec/index.rdf
    Date: 2020-05-26 14:20:01.597998

    """

    _fail = True

    # http://www.w3.org/1999/02/22-rdf-syntax-ns#Property
    account: URIRef  # Indicates an account held by this agent.
    accountName: (
        URIRef  # Indicates the name (identifier) associated with this online account.
    )
    accountServiceHomepage: (
        URIRef  # Indicates a homepage of the service provide for this online account.
    )
    age: URIRef  # The age in years of some agent.
    based_near: URIRef  # A location that something is based near, for some broadly human notion of near.
    birthday: URIRef  # The birthday of this Agent, represented in mm-dd string form, eg. '12-31'.
    currentProject: URIRef  # A current project this person works on.
    depiction: URIRef  # A depiction of some thing.
    depicts: URIRef  # A thing depicted in this representation.
    dnaChecksum: URIRef  # A checksum for the DNA of some thing. Joke.
    familyName: URIRef  # The family name of some person.
    family_name: URIRef  # The family name of some person.
    firstName: URIRef  # The first name of a person.
    focus: URIRef  # The underlying or 'focal' entity associated with some SKOS-described concept.
    fundedBy: URIRef  # An organization funding a project or person.
    geekcode: URIRef  # A textual geekcode for this person, see http://www.geekcode.com/geek.html
    gender: URIRef  # The gender of this Agent (typically but not necessarily 'male' or 'female').
    givenName: URIRef  # The given name of some person.
    givenname: URIRef  # The given name of some person.
    holdsAccount: URIRef  # Indicates an account held by this agent.
    img: URIRef  # An image that can be used to represent some thing (ie. those depictions which are particularly representative of something, eg. one's photo on a homepage).
    interest: URIRef  # A page about a topic of interest to this person.
    knows: URIRef  # A person known by this person (indicating some level of reciprocated interaction between the parties).
    lastName: URIRef  # The last name of a person.
    made: URIRef  # Something that was made by this agent.
    maker: URIRef  # An agent that  made this thing.
    member: URIRef  # Indicates a member of a Group
    membershipClass: (
        URIRef  # Indicates the class of individuals that are a member of a Group
    )
    myersBriggs: URIRef  # A Myers Briggs (MBTI) personality classification.
    name: URIRef  # A name for some thing.
    nick: URIRef  # A short informal nickname characterising an agent (includes login identifiers, IRC and other chat nicknames).
    page: URIRef  # A page or document about this thing.
    pastProject: URIRef  # A project this person has previously worked on.
    phone: URIRef  # A phone,  specified using fully qualified tel: URI scheme (refs: http://www.w3.org/Addressing/schemes.html#tel).
    plan: URIRef  # A .plan comment, in the tradition of finger and '.plan' files.
    primaryTopic: URIRef  # The primary topic of some page or document.
    publications: URIRef  # A link to the publications of this person.
    schoolHomepage: URIRef  # A homepage of a school attended by the person.
    sha1: URIRef  # A sha1sum hash, in hex.
    skypeID: URIRef  # A Skype ID
    status: URIRef  # A string expressing what the user is happy for the general public (normally) to know about their current activity.
    surname: URIRef  # The surname of some person.
    theme: URIRef  # A theme.
    thumbnail: URIRef  # A derived thumbnail image.
    tipjar: URIRef  # A tipjar document for this agent, describing means for payment and reward.
    title: URIRef  # Title (Mr, Mrs, Ms, Dr. etc)
    topic: URIRef  # A topic of some page or document.
    topic_interest: URIRef  # A thing of interest to this person.
    workInfoHomepage: URIRef  # A work info homepage of some person; a page about their work for some organization.
    workplaceHomepage: URIRef  # A workplace homepage of some person; the homepage of an organization they work for.

    # http://www.w3.org/2000/01/rdf-schema#Class
    Agent: URIRef  # An agent (eg. person, group, software or physical artifact).
    Document: URIRef  # A document.
    Group: URIRef  # A class of Agents.
    Image: URIRef  # An image.
    LabelProperty: URIRef  # A foaf:LabelProperty is any RDF property with textual values that serve as labels.
    OnlineAccount: URIRef  # An online account.
    OnlineChatAccount: URIRef  # An online chat account.
    OnlineEcommerceAccount: URIRef  # An online e-commerce account.
    OnlineGamingAccount: URIRef  # An online gaming account.
    Organization: URIRef  # An organization.
    Person: URIRef  # A person.
    PersonalProfileDocument: URIRef  # A personal profile RDF document.
    Project: URIRef  # A project (a collective endeavour of some kind).

    # http://www.w3.org/2002/07/owl#InverseFunctionalProperty
    aimChatID: URIRef  # An AIM chat ID
    homepage: URIRef  # A homepage for some thing.
    icqChatID: URIRef  # An ICQ chat ID
    isPrimaryTopicOf: URIRef  # A document that this thing is the primary topic of.
    jabberID: URIRef  # A jabber ID for something.
    logo: URIRef  # A logo representing some thing.
    mbox: URIRef  # A  personal mailbox, ie. an Internet mailbox associated with exactly one owner, the first owner of this mailbox. This is a 'static inverse functional property', in that  there is (across time and change) at most one individual that ever has any particular value for foaf:mbox.
    mbox_sha1sum: URIRef  # The sha1sum of the URI of an Internet mailbox associated with exactly one owner, the  first owner of the mailbox.
    msnChatID: URIRef  # An MSN chat ID
    openid: URIRef  # An OpenID for an Agent.
    weblog: URIRef  # A weblog of some thing (whether person, group, company etc.).
    yahooChatID: URIRef  # A Yahoo chat ID

    _NS = Namespace("http://xmlns.com/foaf/0.1/")
