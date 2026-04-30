"""
Functionality to convert tabular data in Frictionless Data Packages to CSVW.

We translate [table schemas](https://specs.frictionlessdata.io/table-schema/) defined
for [data resources](https://specs.frictionlessdata.io/data-resource/) in a
[data package](https://specs.frictionlessdata.io/data-package/) to a CVSW TableGroup.

This functionality can be used together with the `frictionless describe` command to add
CSVW metadata to "raw" CSV tables.
"""
import json
import pathlib


def convert_column_spec(spec):
    """
    https://specs.frictionlessdata.io/table-schema/#field-descriptors

    :param spec:
    :return:
    """
    typemap = {
        'year': 'gYear',
        'yearmonth': 'gYearMonth',
    }

    titles = [t for t in [spec.get('title')] if t]

    res = {'name': spec['name'], 'datatype': {'base': 'string'}}
    if 'type' in spec:
        if spec['type'] == 'string' and spec.get('format') == 'binary':
            res['datatype']['base'] = 'binary'
        elif spec['type'] == 'string' and spec.get('format') == 'uri':
            res['datatype']['base'] = 'anyURI'
        elif spec['type'] in typemap:
            res['datatype']['base'] = typemap[spec['type']]
        elif spec['type'] in [
            'string', 'number', 'integer', 'boolean', 'date', 'time', 'datetime', 'duration',
        ]:
            res['datatype']['base'] = spec['type']
            if spec['type'] == 'string' and spec.get('format'):
                res['datatype']['dc:format'] = spec['format']
            if spec['type'] == 'boolean' and spec.get('trueValues') and spec.get('falseValues'):
                res['datatype']['format'] = '{}|{}'.format(
                    spec['trueValues'][0], spec['falseValues'][0])
            if spec['type'] in ['number', 'integer']:
                if spec.get('bareNumber') is True:  # pragma: no cover
                    raise NotImplementedError(
                        'bareNumber is not supported in CSVW. It may be possible to translate to '
                        'a number pattern, though. See '
                        'https://www.w3.org/TR/2015/REC-tabular-data-model-20151217/'
                        '#formats-for-numeric-types')
                if any(prop in spec for prop in ['decimalChar', 'groupChar']):
                    res['datatype']['format'] = {}
                    for p in ['decimalChar', 'groupChar']:
                        if spec.get(p):
                            res['datatype']['format'][p] = spec[p]
        elif spec['type'] in ['object', 'array']:
            res['datatype']['base'] = 'json'
            res['datatype']['dc:format'] = 'application/json'
        elif spec['type'] == 'geojson':
            res['datatype']['base'] = 'json'
            res['datatype']['dc:format'] = 'application/geo+json'

    if titles:
        res['titles'] = titles
    if 'description' in spec:
        res['dc:description'] = [spec['description']]
    if 'rdfType' in spec:
        res['propertyUrl'] = spec['rdfType']

    constraints = spec.get('constraints', {})
    for prop in ['required', 'minLength', 'maxLength', 'minimum', 'maximum']:
        if prop in constraints:
            res['datatype'][prop] = constraints[prop]
        if ('pattern' in constraints) and ('format' not in res['datatype']):
            res['datatype']['format'] = constraints['pattern']
        # FIXME: we could transform the "enum" constraint for string into
        # a regular expression in the "format" property.
    return res


def convert_foreignKey(rsc_name, fk, resource_map):
    """
    https://specs.frictionlessdata.io/table-schema/#foreign-keys
    """
    # Rename "fields" to "columnReference" and map resource name to url (resolving self-referential
    # foreign keys).
    return dict(
        columnReference=fk['fields'],
        reference=dict(
            columnReference=fk['reference']['fields'],
            resource=resource_map[fk['reference']['resource'] or rsc_name],
        )
    )


def convert_table_schema(rsc_name, schema, resource_map):
    """
    :param rsc_name: `name` property of the resource the schema belongs to. Needed to resolve \
    self-referential foreign keys.
    :param schema: `dict` parsed from JSON representing a frictionless Table Schema object.
    :param resource_map: `dict` mapping resource names to resource paths, needed to convert foreign\
    key constraints.
    :return: `dict` suitable for instantiating a `csvw.metadata.Schema` object.
    """
    res = dict(
        columns=[convert_column_spec(f) for f in schema['fields']],
    )
    for prop in [
        ('missingValues', 'null'),
        'primaryKey',
        'foreignKeys',
    ]:
        if isinstance(prop, tuple):
            prop, toprop = prop
        else:
            toprop = prop
        if prop in schema:
            res[toprop] = schema[prop]
            if prop == 'foreignKeys':
                res[toprop] = [convert_foreignKey(rsc_name, fk, resource_map) for fk in res[toprop]]
    return res


def convert_dialect(rsc):
    """
    Limitations: lineTerminator is not supported.

    https://specs.frictionlessdata.io/csv-dialect/
    """
    d = rsc.get('dialect', {})
    # Work around https://github.com/frictionlessdata/frictionless-py/issues/1506
    if 'csv' in d:
        d = d['csv']
    res = {}
    if d.get('delimiter'):
        res['delimiter'] = d['delimiter']
    if rsc.get('encoding'):
        res['encoding'] = rsc['encoding']
    for prop in [
        'delimiter',
        'quoteChar',
        'doubleQuote',
        'skipInitialSpace',
        'header',
    ]:
        if prop in d:
            res[prop] = d[prop]
    if 'commentChar' in d:
        res['commentPrefix'] = d['commentChar']
    return res


class DataPackage:
    def __init__(self, spec, directory=None):
        if isinstance(spec, DataPackage):
            self.json = spec.json
            self.dir = spec.dir
            return
        if isinstance(spec, dict):
            # already a parsed JSON object
            self.dir = pathlib.Path(directory or '.')
        elif isinstance(spec, pathlib.Path):
            self.dir = directory or spec.parent
            spec = json.loads(spec.read_text(encoding='utf8'))
        else:  # assume a JSON formatted string
            spec = json.loads(spec)
            self.dir = pathlib.Path(directory or '.')

        self.json = spec

    def to_tablegroup(self, cls=None):
        from csvw import TableGroup

        md = {'@context': "http://www.w3.org/ns/csvw"}
        # Package metadata:
        md['dc:replaces'] = json.dumps(self.json)

        # version,
        # image,

        for flprop, csvwprop in [
            ('id', 'dc:identifier'),
            ('licenses', 'dc:license'),
            ('title', 'dc:title'),
            ('homepage', 'dcat:accessURL'),
            ('description', 'dc:description'),
            ('sources', 'dc:source'),
            ('contributors', 'dc:contributor'),
            ('profile', 'dc:conformsTo'),
            ('keywords', 'dc:subject'),
            ('created', 'dc:created'),
        ]:
            if flprop in self.json:
                md[csvwprop] = self.json[flprop]

        if 'name' in self.json:
            if 'id' not in self.json:
                md['dc:identifier'] = self.json['name']
            elif 'title' not in self.json:
                md['dc:title'] = self.json['name']

        # Data Resource metadata:
        resources = [rsc for rsc in self.json.get('resources', []) if 'path' in rsc]
        resource_map = {rsc['name']: rsc['path'] for rsc in resources if 'name' in rsc}
        for rsc in resources:
            schema = rsc.get('schema')
            if schema and \
                    rsc.get('scheme') == 'file' and \
                    rsc.get('format') == 'csv':
                # Table Schema:
                md.setdefault('tables', [])
                table = dict(
                    url=rsc['path'],
                    tableSchema=convert_table_schema(rsc.get('name'), schema, resource_map),
                    dialect=convert_dialect(rsc),
                )
                md['tables'].append(table)

        cls = cls or TableGroup
        res = cls.fromvalue(md)
        res._fname = self.dir / 'csvw-metadata.json'
        return res
