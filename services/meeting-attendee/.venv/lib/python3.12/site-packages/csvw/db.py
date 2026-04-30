"""
SQLite as alternative storage backend for a TableGroup's data.

For the most part, translation of a TableGroup's tableSchema to SQL works as expected:

- each table is converted to a `CREATE TABLE` statement
- each column specifies a column in the corresponding `CREATE TABLE` statement
- `foreignKey` constraints are added according to the corresponding `tableSchema` property.

List-valued foreignKeys are supported as follows: For each pair of tables related through a
list-valued foreign key, an association table is created. To make it possible to distinguish
multiple list-valued foreign keys between the same two tables, the association table has
a column `context`, which stores the name of the foreign key column from which a row in the
assocation table was created.

Other list-valued columns work in two different ways: If the atomic datatype is `string`, the
specified separator is used to create a concatenated string representation in the database field.
Otherwise, the list of values is serialized as JSON.

SQL table and column names can be customized by passing a translator callable when instantiating
a :class:`Database`.

SQLite support has the following limitations:

- regex constraints on strings (as specified via a :class:`csvw.Datatype`'s format attribute) are
  not enforced by the database.
"""
import json
import typing
import decimal
import pathlib
import sqlite3
import functools
import contextlib
import collections

import attr

import csvw
from csvw.datatypes import DATATYPES
from csvw.metadata import TableGroup


def identity(s):
    return s


TYPE_MAP = {
    'string': (
        'TEXT',
        identity,
        identity),
    'integer': (
        'INTEGER',
        identity,
        identity),
    'boolean': (
        'INTEGER',
        lambda s: s if s is None else int(s),
        lambda s: s if s is None else bool(s)),
    'decimal': (
        'REAL',
        lambda s: s if s is None else float(s),
        lambda s: s if s is None else decimal.Decimal(s)),
    'hexBinary': (
        'BLOB',
        identity,
        identity),
}


class SchemaTranslator(typing.Protocol):
    def __call__(self, table: str, column: typing.Optional[str] = None) -> str:
        ...  # pragma: no cover


class ColumnTranslator(typing.Protocol):
    def __call__(self, column: str) -> str:
        ...  # pragma: no cover


def quoted(*names):
    return ','.join('`{0}`'.format(name) for name in names)


def insert(db: sqlite3.Connection,
           translate: SchemaTranslator,
           table: str,
           keys: typing.Sequence[str],
           *rows: list,
           single: typing.Optional[bool] = False):
    """
    Insert a sequence of rows into a table.

    :param db: Database connection.
    :param translate: Callable translating table and column names to proper schema object names.
    :param table: Untranslated table name.
    :param keys: Untranslated column names.
    :param rows: Sequence of rows to insert.
    :param single: Flag signaling whether to insert all rows at once using `executemany` or one at \
    a time, allowing for more focused debugging output in case of errors.
    """
    if rows:
        sql = "INSERT INTO {0} ({1}) VALUES ({2})".format(
            quoted(translate(table)),
            quoted(*[translate(table, k) for k in keys]),
            ','.join(['?' for _ in keys]))
        try:
            db.executemany(sql, rows)
        except:  # noqa: E722 - this is purely for debugging.
            if not single:
                for row in rows:
                    insert(db, translate, table, keys, row, single=True)
            else:
                print(sql)
                print(rows)
                raise


def select(db: sqlite3.Connection, table: str) -> typing.Tuple[typing.List[str], typing.Sequence]:
    cu = db.execute("SELECT * FROM {0}".format(quoted(table)))
    cols = [d[0] for d in cu.description]
    return cols, list(cu.fetchall())


@attr.s
class ColSpec:
    """
    A `ColSpec` captures sufficient information about a :class:`csvw.Column` for the DB schema.
    """
    name = attr.ib()
    csvw_type = attr.ib(default='string', converter=lambda s: s if s else 'string')
    separator = attr.ib(default=None)
    db_type = attr.ib(default=None)
    convert = attr.ib(default=None)
    read = attr.ib(default=None)
    required = attr.ib(default=False)
    csvw = attr.ib(default=None)

    def __attrs_post_init__(self):
        if self.csvw_type in TYPE_MAP:
            self.db_type, self.convert, self.read = TYPE_MAP[self.csvw_type]
        else:
            self.db_type = 'TEXT'
            self.convert = DATATYPES[self.csvw_type].to_string
            self.read = DATATYPES[self.csvw_type].to_python
        if self.separator and self.db_type != 'TEXT':
            self.db_type = 'TEXT'

    def check(self, translate: ColumnTranslator) -> typing.Optional[str]:
        """
        We try to convert as many data constraints as possible into SQLite CHECK constraints.

        :param translate: Callable to translate column names between CSVW metadata and DB schema.
        :return: A string suitable as argument of an SQL CHECK constraint.
        """
        if not self.csvw:
            return
        c, cname = self.csvw, translate(self.name)
        constraints = []
        if (c.minimum is not None) or (c.maximum is not None):
            func = {
                'date': 'date',
                'datetime': 'datetime',
            }.get(self.csvw_type)
            if c.minimum is not None:
                if func:
                    constraints.append("{2}(`{0}`) >= {2}('{1}')".format(cname, c.minimum, func))
                else:
                    constraints.append('`{0}` >= {1}'.format(cname, c.minimum))
            if c.maximum is not None:
                if func:
                    constraints.append("{2}(`{0}`) <= {2}('{1}')".format(cname, c.maximum, func))
                else:
                    constraints.append('`{0}` <= {1}'.format(cname, c.maximum))
        elif any(cc is not None for cc in [c.length, c.minLength, c.maxLength]):
            if c.length:
                constraints.append('length(`{0}`) = {1}'.format(cname, c.length))
            if c.minLength:
                constraints.append('length(`{0}`) >= {1}'.format(cname, c.minLength))
            if c.maxLength:
                constraints.append('length(`{0}`) <= {1}'.format(cname, c.maxLength))
        return ' AND '.join(constraints)

    def sql(self, translate: ColumnTranslator) -> str:
        _check = self.check(translate)
        return '`{0}` {1}{2}{3}'.format(
            translate(self.name),
            self.db_type,
            ' NOT NULL' if self.required else '',
            ' CHECK ({0})'.format(_check) if _check else '')


@attr.s
class TableSpec(object):
    """
    A `TableSpec` captures sufficient information about a :class:`csvw.Table` for the DB schema.

    .. note::

        We support "light-weight" many-to-many relationships by allowing list-valued foreign key
        columns in CSVW. In the database these columns are turned into an associative table, adding
        the name of the column as value a `context` column. Thus, multiple columns in a table my be
        specified as targets of many-to-many relations with the same table.

        .. seealso:: `<https://en.wikipedia.org/wiki/Associative_entity>`_
    """
    name = attr.ib()
    columns = attr.ib(default=attr.Factory(list))
    foreign_keys = attr.ib(default=attr.Factory(list))
    many_to_many = attr.ib(default=attr.Factory(collections.OrderedDict))
    primary_key = attr.ib(default=None)

    @classmethod
    def from_table_metadata(cls,
                            table: csvw.Table,
                            drop_self_referential_fks: typing.Optional[bool] = True) -> 'TableSpec':
        """
        Create a `TableSpec` from the schema description of a `csvw.metadata.Table`.

        :param table: `csvw.metadata.Table` instance.
        :param drop_self_referential_fks: Flag signaling whether to drop self-referential foreign \
        keys. This may be necessary, if the order of rows in a CSVW table does not guarantee \
        referential integrity when inserted in order (e.g. an eralier row refering to a later one).
        :return: `TableSpec` instance.
        """
        spec = cls(name=table.local_name, primary_key=table.tableSchema.primaryKey)
        list_valued = {c.header for c in table.tableSchema.columns if c.separator}
        for fk in table.tableSchema.foreignKeys:
            # We only support Foreign Key references between tables!
            if not fk.reference.schemaReference:
                if len(fk.columnReference) == 1 and fk.columnReference[0] in list_valued:
                    # List-valued foreign keys are turned into a many-to-many relation!
                    assert len(fk.reference.columnReference) == 1, \
                        'Composite key {0} in table {1} referenced'.format(
                            fk.reference.columnReference,
                            fk.reference.resource)
                    assert spec.primary_key and len(spec.primary_key) == 1, \
                        'Table {0} referenced by list-valued foreign key must have non-composite ' \
                        'primary key'.format(spec.name)
                    spec.many_to_many[fk.columnReference[0]] = TableSpec.association_table(
                        spec.name,
                        spec.primary_key[0],
                        fk.reference.resource.string,
                        fk.reference.columnReference[0],
                    )
                elif not (drop_self_referential_fks and fk.reference.resource.string == spec.name):
                    spec.foreign_keys.append((
                        sorted(fk.columnReference),
                        fk.reference.resource.string,
                        sorted(fk.reference.columnReference),
                    ))
        for c in table.tableSchema.columns:
            if c.header not in spec.many_to_many:
                datatype = c.inherit('datatype')
                spec.columns.append(ColSpec(
                    name=c.header,
                    csvw_type=datatype.base if datatype else datatype,
                    separator=c.inherit('separator'),
                    required=c.inherit('required'),
                    csvw=c.inherit('datatype'),
                ))
        return spec

    @classmethod
    def association_table(cls, atable, apk, btable, bpk) -> 'TableSpec':
        """
        List-valued foreignKeys are supported as follows: For each pair of tables related through a
        list-valued foreign key, an association table is created. To make it possible to distinguish
        multiple list-valued foreign keys between the same two tables, the association table has
        a column `context`, which stores the name of the foreign key column from which a row in the
        assocation table was created.
        """
        afk = ColSpec('{0}_{1}'.format(atable, apk))
        bfk = ColSpec('{0}_{1}'.format(btable, bpk))
        if afk.name == bfk.name:
            afk.name += '_1'
            bfk.name += '_2'
        return cls(
            name='{0}_{1}'.format(atable, btable),
            columns=[afk, bfk, ColSpec('context')],
            foreign_keys=[
                ([afk.name], atable, [apk]),
                ([bfk.name], btable, [bpk]),
            ]
        )

    def sql(self, translate: SchemaTranslator) -> str:
        """
        :param translate:
        :return: The SQL statement to create the table.
        """
        col_translate = functools.partial(translate, self.name)
        clauses = [col.sql(col_translate) for col in self.columns]
        if self.primary_key:
            clauses.append('PRIMARY KEY({0})'.format(quoted(
                *[col_translate(c) for c in self.primary_key])))
        for fk, ref, refcols in self.foreign_keys:
            clauses.append('FOREIGN KEY({0}) REFERENCES {1}({2}) ON DELETE CASCADE'.format(
                quoted(*[col_translate(c) for c in fk]),
                quoted(translate(ref)),
                quoted(*[translate(ref, c) for c in refcols])))
        return "CREATE TABLE IF NOT EXISTS `{0}` (\n    {1}\n)".format(
            translate(self.name), ',\n    '.join(clauses))


def schema(tg: csvw.TableGroup,
           drop_self_referential_fks: typing.Optional[bool] = True) -> typing.List[TableSpec]:
    """
    Convert the table and column descriptions of a `TableGroup` into specifications for the
    DB schema.

    :param tg: CSVW TableGroup.
    :param drop_self_referential_fks: Flag signaling whether to drop self-referential foreign \
    keys. This may be necessary, if the order of rows in a CSVW table does not guarantee \
    referential integrity when inserted in order (e.g. an eralier row refering to a later one).
    :return: A pair (tables, reference_tables).
    """
    tables = {}
    for tname, table in tg.tabledict.items():
        t = TableSpec.from_table_metadata(
            table, drop_self_referential_fks=drop_self_referential_fks)
        tables[t.name] = t
        for at in t.many_to_many.values():
            tables[at.name] = at

    # We must determine the order in which tables must be created!
    ordered = collections.OrderedDict()
    i = 0

    # We loop through the tables repeatedly, and whenever we find one, which has all
    # referenced tables already in ordered, we move it from tables to ordered.
    while tables and i < 100:
        i += 1
        for table in list(tables.keys()):
            if all((ref[1] in ordered) or ref[1] == table for ref in tables[table].foreign_keys):
                # All referenced tables are already created (or self-referential).
                ordered[table] = tables.pop(table)
                break
    if tables:  # pragma: no cover
        raise ValueError('there seem to be cyclic dependencies between the tables')

    return list(ordered.values())


class Database(object):
    """
    Represents a SQLite database associated with a :class:`csvw.TableGroup` instance.

    :param tg: `TableGroup` instance defining the schema of the database.
    :param fname: Path to which to write the database file.
    :param translate: Schema object name translator.
    :param drop_self_referential_fks: Flag signaling whether to drop or enforce self-referential \
    foreign-key constraints.

    .. warning::

        We write rows of a table to the database sequentially. Since CSVW does not require ordering
        rows in tables such that self-referential foreign-key constraints are satisfied at each row,
        we don't enforce self-referential foreign-keys by default in order to not trigger "false"
        integrity errors. If data in a CSVW Table is known to be ordered appropriately, `False`
        should be passed as `drop_self_referential_fks` keyword parameter to enforce
        self-referential foreign-keys.
    """
    def __init__(
            self,
            tg: TableGroup,
            fname: typing.Optional[typing.Union[pathlib.Path, str]] = None,
            translate: typing.Optional[SchemaTranslator] = None,
            drop_self_referential_fks: typing.Optional[bool] = True,
    ):
        self.translate = translate or Database.name_translator
        self.fname = pathlib.Path(fname) if fname else None
        self.init_schema(tg, drop_self_referential_fks=drop_self_referential_fks)
        self._connection = None  # For in-memory dbs we need to keep the connection!

    def init_schema(self, tg, drop_self_referential_fks=True):
        self.tg = tg
        self.tables = schema(
            self.tg, drop_self_referential_fks=drop_self_referential_fks) if self.tg else []

    @property
    def tdict(self) -> typing.Dict[str, TableSpec]:
        return {t.name: t for t in self.tables}

    @staticmethod
    def name_translator(table: str, column: typing.Optional[str] = None) -> str:
        """
        A callable with this signature can be passed into DB creation to control the names
        of the schema objects.

        :param table: CSVW name of the table before translation
        :param column: CSVW name of a column of `table` before translation
        :return: Translated table name if `column is None` else translated column name
        """
        # By default, no translation is done:
        return column or table

    def connection(self) -> typing.Union[sqlite3.Connection, contextlib.closing]:
        if self.fname:
            return contextlib.closing(sqlite3.connect(str(self.fname)))
        if not self._connection:
            self._connection = sqlite3.connect(':memory:')
        return self._connection

    def select_many_to_many(self, db, table, context) -> dict:
        if context is not None:
            context_sql = "WHERE context = '{0}'".format(context)
        else:
            context_sql = ''
        sql = """\
SELECT {0}, group_concat({1}, ' '), group_concat(COALESCE(context, ''), '||')
FROM {2} {3} GROUP BY {0}""".format(
                quoted(self.translate(table.name, table.columns[0].name)),
                quoted(self.translate(table.name, table.columns[1].name)),
                quoted(self.translate(table.name)),
                context_sql)
        cu = db.execute(sql)
        return {
            r[0]: [(k, v) if context is None else k
                   for k, v in zip(r[1].split(), r[2].split('||'))] for r in cu.fetchall()}

    def separator(self, tname: str, cname: str) -> typing.Optional[str]:
        """
        :return: separator for the column specified by db schema names `tname` and `cname`.
        """
        for name in self.tdict:
            if self.translate(name) == tname:
                for col in self.tdict[name].columns:
                    if self.translate(name, col.name) == cname:
                        return col.separator

    def split_value(self, tname, cname, value) -> typing.Union[typing.List[str], str, None]:
        sep = self.separator(tname, cname)
        return (value or '').split(sep) if sep else value

    def read(self) -> typing.Dict[str, typing.List[typing.OrderedDict]]:
        """
        :return: A `dict` where keys are SQL table names corresponding to CSVW tables and values \
        are lists of rows, represented as dicts where keys are the SQL column names.
        """
        res = collections.defaultdict(list)
        with self.connection() as conn:
            for tname in self.tg.tabledict:
                #
                # FIXME: how much do we want to use DB types? Probably as much as possible!
                # Thus we need to convert on write **and** read!
                #
                convert, seps, refs = {}, {}, collections.defaultdict(dict)
                table = self.tdict[tname]  # The TableSpec object.

                # Assemble the conversion dictionary:
                for col in table.columns:
                    convert[self.translate(tname, col.name)] = [col.name, identity]
                    if col.csvw_type in TYPE_MAP:
                        convert[self.translate(tname, col.name)][1] = TYPE_MAP[col.csvw_type][2]
                    else:
                        convert[self.translate(tname, col.name)][1] = \
                            DATATYPES[col.csvw_type].to_python
                    if col.separator:
                        if col.csvw_type == 'string':
                            seps[self.translate(tname, col.name)] = col.separator
                        else:
                            seps[self.translate(tname, col.name)] = 'json'

                # Retrieve the many-to-many relations:
                for col, at in table.many_to_many.items():
                    for pk, v in self.select_many_to_many(conn, at, col).items():
                        refs[pk][self.translate(tname, col)] = v

                cols, rows = select(conn, self.translate(tname))
                for row in rows:
                    d = collections.OrderedDict()
                    for k, v in zip(cols, row):
                        if k in seps:
                            if v is None:
                                d[k] = None
                            elif not v:
                                d[k] = []
                            elif seps[k] == 'json':
                                d[k] = json.loads(v)
                            else:
                                d[k] = [convert[k][1](v_) for v_ in (v or '').split(seps[k])]
                        else:
                            d[k] = convert[k][1](v) if v is not None else None
                    pk = d[self.translate(tname, table.primary_key[0])] \
                        if table.primary_key and len(table.primary_key) == 1 else None
                    d.update({k: [] for k in table.many_to_many})
                    d.update(refs.get(pk, {}))
                    res[self.translate(tname)].append(d)
        return res

    def association_table_context(self, table, column, fkey):
        """
        Context for association tables is created calling this method.

        Note: If a custom value for the `context` column is created by overwriting this method,
        `select_many_to_many` must be adapted accordingly, to make sure the custom
        context is retrieved when reading the data from the db.

        :param table:
        :param column:
        :param fkey:
        :return: a pair (foreign key, context)
        """
        # The default implementation takes the column name as context:
        return fkey, column

    def write_from_tg(self, _force=False, _exists_ok=False, _skip_extra=False):
        return self.write(
            force=_force,
            _exists_ok=_exists_ok,
            _skip_extra=_skip_extra,
            **self.tg.read())

    def write(self, *, force=False, _exists_ok=False, _skip_extra=False, **items):
        """
        Creates a db file with the core schema.

        :param force: If `True` an existing db file will be overwritten.
        """
        if self.fname and self.fname.exists():
            if not force:
                raise ValueError('db file already exists, use force=True to overwrite')
            else:
                self.fname.unlink()

        with self.connection() as db:
            for table in self.tables:
                db.execute(table.sql(translate=self.translate))

            db.execute('PRAGMA foreign_keys = ON;')
            db.commit()

            refs = collections.defaultdict(list)  # collects rows in association tables.
            for t in self.tables:
                if t.name not in items:
                    continue
                rows, keys = [], []
                cols = {c.name: c for c in t.columns}
                for i, row in enumerate(items[t.name]):
                    pk = row[t.primary_key[0]] \
                        if t.primary_key and len(t.primary_key) == 1 else None
                    values = []
                    for k, v in row.items():
                        if k in t.many_to_many:
                            assert pk
                            at = t.many_to_many[k]
                            atkey = tuple([at.name] + [c.name for c in at.columns])
                            # We distinguish None - meaning NULL - and [] - meaning no items - as
                            # values of list-valued columns.
                            for vv in (v or []):
                                fkey, context = self.association_table_context(t, k, vv)
                                refs[atkey].append((pk, fkey, context))
                        else:
                            if k not in cols:
                                if _skip_extra:
                                    continue
                                else:
                                    raise ValueError(
                                        'unspecified column {0} found in data'.format(k))
                            col = cols[k]
                            if isinstance(v, list):
                                # Note: This assumes list-valued columns are of datatype string!
                                if col.csvw_type == 'string':
                                    v = (col.separator or ';').join(
                                        col.convert(vv) or '' for vv in v)
                                else:
                                    v = json.dumps(v)
                            else:
                                v = col.convert(v) if v is not None else None
                            if i == 0:
                                keys.append(col.name)
                            values.append(v)
                    rows.append(tuple(values))
                insert(db, self.translate, t.name, keys, *rows)

            for atkey, rows in refs.items():
                insert(db, self.translate, atkey[0], atkey[1:], *rows)

            db.commit()
