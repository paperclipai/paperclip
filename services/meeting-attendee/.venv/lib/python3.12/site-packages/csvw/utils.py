import re
import copy
import html
import json
import string
import keyword
import pathlib
import warnings
import collections
import unicodedata

import attr


def is_url(s):
    return re.match(r'https?://', str(s))


def converter(type_, default, s, allow_none=False, cond=None, allow_list=True):
    if allow_list and type_ != list and isinstance(s, list):
        return [v for v in [converter(type_, None, ss, cond=cond) for ss in s] if v is not None]

    if allow_none and s is None:
        return s
    if not isinstance(s, type_) or (type_ == int and isinstance(s, bool)) or (cond and not cond(s)):
        warnings.warn('Invalid value for property: {}'.format(s))
        return default
    return s


def ensure_path(fname):
    if not isinstance(fname, pathlib.Path):
        assert isinstance(fname, str)
        return pathlib.Path(fname)
    return fname


def attr_defaults(cls):
    res = collections.OrderedDict()
    for field in attr.fields(cls):
        default = field.default
        if isinstance(default, attr.Factory):
            default = default.factory()
        res[field.name] = default
    return res


def attr_asdict(obj, omit_defaults=True, omit_private=True):
    defs = attr_defaults(obj.__class__)
    res = collections.OrderedDict()
    for field in attr.fields(obj.__class__):
        if not (omit_private and field.name.startswith('_')):
            value = getattr(obj, field.name)
            if not (omit_defaults and value == defs[field.name]):
                if hasattr(value, 'asdict'):
                    value = value.asdict(omit_defaults=True)
                res[field.name] = value
    return res


def normalize_name(s):
    """Convert a string into a valid python attribute name.
    This function is called to convert ASCII strings to something that can pass as
    python attribute name, to be used with namedtuples.

    >>> str(normalize_name('class'))
    'class_'
    >>> str(normalize_name('a-name'))
    'a_name'
    >>> str(normalize_name('a n\u00e4me'))
    'a_name'
    >>> str(normalize_name('Name'))
    'Name'
    >>> str(normalize_name(''))
    '_'
    >>> str(normalize_name('1'))
    '_1'
    """
    s = s.replace('-', '_').replace('.', '_').replace(' ', '_')
    if s in keyword.kwlist:
        return s + '_'
    s = '_'.join(slug(ss, lowercase=False) for ss in s.split('_'))
    if not s:
        s = '_'
    if s[0] not in string.ascii_letters + '_':
        s = '_' + s
    return s


def slug(s, remove_whitespace=True, lowercase=True):
    """Condensed version of s, containing only lowercase alphanumeric characters.

    >>> str(slug('A B. \u00e4C'))
    'abac'
    """
    res = ''.join(c for c in unicodedata.normalize('NFD', s)
                  if unicodedata.category(c) != 'Mn')
    if lowercase:
        res = res.lower()
    for c in string.punctuation:
        res = res.replace(c, '')
    res = re.sub(r'\s+', '' if remove_whitespace else ' ', res)
    res = res.encode('ascii', 'ignore').decode('ascii')
    assert re.match('[ A-Za-z0-9]*$', res)
    return res


def qname2url(qname):
    for prefix, uri in {
        'csvw': 'http://www.w3.org/ns/csvw#',
        'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
        'xsd': 'http://www.w3.org/2001/XMLSchema#',
        'dc': 'http://purl.org/dc/terms/',
        'dcat': 'http://www.w3.org/ns/dcat#',
        'prov': 'http://www.w3.org/ns/prov#',
    }.items():
        if qname.startswith(prefix + ':'):
            return qname.replace(prefix + ':', uri)


def metadata2markdown(tg, link_files=False) -> str:
    """
    Render the metadata of a dataset as markdown.

    :param link_files: If True, links to data files will be added, assuming the markdown is stored \
    in the same directory as the metadata file.
    :return: `str` with markdown formatted text
    """
    def qname2link(qname, html=False):
        url = qname2url(qname)
        if url:
            if html:
                return '<a href="{}">{}</a>'.format(url, qname)
            return '[{}]({})'.format(qname, url)
        return qname

    def htmlify(obj, key=None):
        """
        For inclusion in tables we must use HTML for lists.
        """
        if isinstance(obj, list):
            return '<ol>{}</ol>'.format(
                ''.join('<li>{}</li>'.format(htmlify(item, key=key)) for item in obj))
        if isinstance(obj, dict):
            items = []
            for k, v in obj.items():
                items.append('<dt>{}</dt><dd>{}</dd>'.format(
                    qname2link(k, html=True), html.escape(str(v))))
            return '<dl>{}</dl>'.format(''.join(items))
        return str(obj)

    def properties(props):
        props = {k: v for k, v in copy.deepcopy(props).items() if v}
        res = []
        desc = props.pop('dc:description', None)
        if desc:
            res.append(desc + '\n')
        img = props.pop('https://schema.org/image', None)
        if img:
            if isinstance(img, str):  # pragma: no cover
                img = {'contentUrl': img}
            res.append('![{}]({})\n'.format(
                img.get('https://schema.org/caption') or '',
                img.get('https://schema.org/contentUrl')))
        if props:
            res.append('property | value\n --- | ---')
            for k, v in props.items():
                res.append('{} | {}'.format(qname2link(k), htmlify(v, key=k)))
        return '\n'.join(res) + '\n'

    def colrow(col, fks, pk):
        dt = '`{}`'.format(col.datatype.base if col.datatype else 'string')
        if col.datatype:
            if col.datatype.format:
                if re.fullmatch(r'[\w\s]+(\|[\w\s]+)*', col.datatype.format):
                    dt += '<br>Valid choices:<br>'
                    dt += ''.join(' `{}`'.format(w) for w in col.datatype.format.split('|'))
                elif col.datatype.base == 'string':
                    dt += '<br>Regex: `{}`'.format(col.datatype.format)
            if col.datatype.minimum:
                dt += '<br>&ge; {}'.format(col.datatype.minimum)
            if col.datatype.maximum:
                dt += '<br>&le; {}'.format(col.datatype.maximum)
        if col.separator:
            dt = 'list of {} (separated by `{}`)'.format(dt, col.separator)
        desc = col.common_props.get('dc:description', '').replace('\n', ' ')

        if pk and col.name in pk:
            desc = (desc + '<br>') if desc else desc
            desc += 'Primary key'

        if col.name in fks:
            desc = (desc + '<br>') if desc else desc
            desc += 'References [{}::{}](#table-{})'.format(
                fks[col.name][1], fks[col.name][0], slug(fks[col.name][1]))

        return ' | '.join([
            '[{}]({})'.format(col.name, col.propertyUrl)
            if col.propertyUrl else '`{}`'.format(col.name),
            dt,
            desc,
        ])

    res = ['# {}\n'.format(tg.common_props.get('dc:title', 'Dataset'))]
    if tg._fname and link_files:
        res.append('> [!NOTE]\n> Described by [{0}]({0}).\n'.format(tg._fname.name))

    res.append(properties({k: v for k, v in tg.common_props.items() if k != 'dc:title'}))

    for table in tg.tables:
        fks = {
            fk.columnReference[0]: (fk.reference.columnReference[0], fk.reference.resource.string)
            for fk in table.tableSchema.foreignKeys if len(fk.columnReference) == 1}
        header = '## <a name="table-{}"></a>Table '.format(slug(table.url.string))
        if link_files and tg._fname and tg._fname.parent.joinpath(table.url.string).exists():
            header += '[{0}]({0})\n'.format(table.url.string)
        else:  # pragma: no cover
            header += table.url.string
        res.append('\n' + header + '\n')
        res.append(properties(table.common_props))
        dialect = table.inherit('dialect')
        if dialect.asdict():
            res.append('\n**CSV dialect**: `{}`\n'.format(json.dumps(dialect.asdict())))
        res.append('\n### Columns\n')
        res.append('Name/Property | Datatype | Description')
        res.append(' --- | --- | --- ')
        for col in table.tableSchema.columns:
            res.append(colrow(col, fks, table.tableSchema.primaryKey))
    return '\n'.join(res)
