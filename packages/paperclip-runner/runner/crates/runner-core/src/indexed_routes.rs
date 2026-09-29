//! Immutable, bounded B+tree pages. SQLite publishes only a root reference in
//! the same transaction as current authority. New pages are synced first, so a
//! rollback can leave unreachable pages but never a partially published tree.
//! Old pages stay immutable while an online snapshot holds their root.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

const FANOUT: usize = 32;
// Includes worst-case JSON escaping of every admitted key/path in 32 rows.
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;

#[path = "indexed_routes_gc.rs"]
mod gc;
pub(crate) use gc::RoutingCollector;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Route {
    pub lower: String,
    pub file: String,
    pub records: i64,
    pub bytes: i64,
    pub fingerprint: Vec<u8>,
}
impl Route {
    pub(super) fn empty(lower: String, file: String) -> Self {
        Self {
            lower,
            file,
            records: 0,
            bytes: 0,
            fingerprint: vec![0; 32],
        }
    }
    fn splittable_bytes(&self) -> i64 {
        if self.records > 1 {
            self.bytes
        } else {
            0
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct PageRef {
    sha: String,
    /// The current root fits in one bounded SQLite value. Updating the root
    /// alone must not create/fsync a new filesystem object on every receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inline: Option<String>,
    // Only an incomplete backup may reference another store. A finished
    // backup verifies every reachable page is local before publication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Edge {
    lower: String,
    largest: i64,
    page: PageRef,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum Node {
    Leaf { rows: Vec<Route> },
    Branch { level: u16, children: Vec<Edge> },
}
impl Node {
    fn level(&self) -> u16 {
        match self {
            Self::Leaf { .. } => 0,
            Self::Branch { level, .. } => *level,
        }
    }
    fn edge(&self, page: PageRef) -> Edge {
        match self {
            Self::Leaf { rows } => Edge {
                lower: rows[0].lower.clone(),
                largest: rows.iter().map(Route::splittable_bytes).max().unwrap(),
                page,
            },
            Self::Branch { children, .. } => Edge {
                lower: children[0].lower.clone(),
                largest: children.iter().map(|r| r.largest).max().unwrap(),
                page,
            },
        }
    }
    fn validate(&self) -> Result<()> {
        let keys: Vec<&str> = match self {
            Self::Leaf { rows } => {
                if rows.iter().any(|r| {
                    r.lower.len() > 4096
                        || r.file.len() > 4096
                        || r.records < 0
                        || r.bytes < 0
                        || r.fingerprint.len() != 32
                }) {
                    return Err(invalid("invalid receipt routing row"));
                }
                rows.iter().map(|r| r.lower.as_str()).collect()
            }
            Self::Branch { level, children } => {
                if *level == 0
                    || children
                        .iter()
                        .any(|r| r.largest < 0 || !valid_ref(&r.page) || r.page.inline.is_some())
                {
                    return Err(invalid("invalid receipt routing branch"));
                }
                children.iter().map(|r| r.lower.as_str()).collect()
            }
        };
        if keys.is_empty()
            || keys.len() > FANOUT
            || keys.iter().any(|k| k.len() > 4096)
            || keys.windows(2).any(|p| p[0] >= p[1])
        {
            return Err(invalid("invalid receipt routing order/fanout"));
        }
        Ok(())
    }
}

fn valid_ref(page: &PageRef) -> bool {
    page.sha.len() == 64
        && page
            .sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && page
            .inline
            .as_ref()
            .is_none_or(|value| value.len() <= MAX_PAGE_BYTES)
        && page
            .origin
            .as_ref()
            .is_none_or(|p| p.len() <= 4096 && Path::new(p).is_absolute())
}
fn root_directory(db: &Connection) -> Result<PathBuf> {
    Ok(PathBuf::from(format!(
        "{}.routing",
        db.path()
            .ok_or_else(|| invalid("routing root has no path"))?
    )))
}
fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => fs::File::open(path.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(error)?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(error(e)),
    }
    crate::durable::verify_private_directory(path)
}
fn page_path(db: &Connection, page: &PageRef, create: bool) -> Result<PathBuf> {
    if !valid_ref(page) {
        return Err(invalid("invalid receipt routing reference"));
    }
    let root = page
        .origin
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or(root_directory(db)?);
    let directory = root.join(&page.sha[..2]).join(&page.sha[2..4]);
    for p in [&root, &root.join(&page.sha[..2]), &directory] {
        if create {
            private_directory(p)?;
        } else {
            crate::durable::verify_private_directory(p)?;
        }
    }
    Ok(directory.join(format!("{}.json", &page.sha[4..])))
}
fn read_node(db: &Connection, page: &PageRef) -> Result<Node> {
    #[cfg(test)]
    READ_PAGES.with(|reads| reads.set(reads.get() + 1));
    if !valid_ref(page) {
        return Err(invalid("invalid receipt routing reference"));
    }
    let bytes = if let Some(value) = &page.inline {
        value.as_bytes().to_vec()
    } else {
        let path = page_path(db, page, false)?;
        let file = crate::durable::open_private_regular_file(&path).map_err(error)?;
        let mut bytes = Vec::new();
        file.take((MAX_PAGE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        bytes
    };
    if bytes.len() > MAX_PAGE_BYTES || format!("{:x}", Sha256::digest(&bytes)) != page.sha {
        return Err(invalid("receipt routing page digest/size mismatch"));
    }
    let mut node: Node = serde_json::from_slice(&bytes).map_err(error)?;
    node.validate()?;
    if let Node::Branch { children, .. } = &mut node {
        for child in children {
            if child.page.origin.is_none() {
                child.page.origin = page.origin.clone();
            }
        }
    }
    Ok(node)
}
fn write_node(db: &Connection, node: &Node) -> Result<Edge> {
    node.validate()?;
    let bytes = serde_json::to_vec(node).map_err(error)?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err(invalid("receipt routing page exceeds bound"));
    }
    let page = PageRef {
        sha: format!("{:x}", Sha256::digest(&bytes)),
        inline: None,
        origin: None,
    };
    let path = page_path(db, &page, true)?;
    // A deterministic file name makes interrupted/repeated staging idempotent.
    // Write through a fresh temporary inode and publish without replacing a
    // pre-existing page. A conflicting existing file is an integrity failure.
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(error)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(error)?;
    drop(file);
    match fs::hard_link(&temporary, &path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            read_node(db, &page)?;
        }
        Err(e) => return Err(error(e)),
    }
    fs::remove_file(&temporary).map_err(error)?;
    fs::File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(error)?;
    Ok(node.edge(page))
}
fn inline_node(db: &Connection, node: &Node) -> Result<Edge> {
    node.validate()?;
    let value = serde_json::to_string(node).map_err(error)?;
    if value.len() > MAX_PAGE_BYTES {
        return Err(invalid("receipt routing root exceeds bound"));
    }
    // Keep an owned directory even before the first root subdivision; archive
    // and backup publication always carry the same complete store shape.
    private_directory(&root_directory(db)?)?;
    Ok(node.edge(PageRef {
        sha: format!("{:x}", Sha256::digest(value.as_bytes())),
        inline: Some(value),
        origin: None,
    }))
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS receipt_routing_heads(name TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID;").map_err(error)
}
fn head(db: &Connection, name: &str) -> Result<Option<Edge>> {
    let value: Option<String> = db.query_row("SELECT CASE WHEN length(root)<=8388608 THEN root END FROM receipt_routing_heads WHERE name=?1", [name], |r| r.get(0)).optional().map_err(error)?;
    value
        .map(|v| serde_json::from_str::<Edge>(&v).map_err(error))
        .transpose()
}
fn publish(db: &Connection, name: &str, edge: Option<Edge>) -> Result<()> {
    if let Some(edge) = edge {
        db.execute("INSERT INTO receipt_routing_heads VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET root=excluded.root", params![name, serde_json::to_string(&edge).map_err(error)?]).map_err(error)?;
    } else {
        db.execute("DELETE FROM receipt_routing_heads WHERE name=?1", [name])
            .map_err(error)?;
    }
    Ok(())
}
fn checked_child(db: &Connection, edge: &Edge, level: Option<u16>) -> Result<Node> {
    let node = read_node(db, &edge.page)?;
    let actual = node.edge(edge.page.clone());
    if actual.lower != edge.lower
        || actual.largest != edge.largest
        || level.is_some_and(|l| l != node.level())
    {
        return Err(invalid("receipt routing child differs from parent"));
    }
    Ok(node)
}
pub(super) fn floor(db: &Connection, name: &str, key: &str) -> Result<Option<Route>> {
    let Some(mut edge) = head(db, name)? else {
        return Ok(None);
    };
    let mut level = None;
    loop {
        match checked_child(db, &edge, level)? {
            Node::Leaf { rows } => {
                return Ok(rows.into_iter().rev().find(|r| r.lower.as_str() <= key))
            }
            Node::Branch { level: l, children } => {
                let Some(next) = children.into_iter().rev().find(|r| r.lower.as_str() <= key)
                else {
                    return Ok(None);
                };
                edge = next;
                level = Some(l - 1);
            }
        }
    }
}
pub(super) fn exact(db: &Connection, name: &str, key: &str) -> Result<Option<Route>> {
    Ok(floor(db, name, key)?.filter(|r| r.lower == key))
}
pub(super) fn next(db: &Connection, name: &str, after: Option<&str>) -> Result<Option<Route>> {
    next_page(db, name, after, false)
}
/// Verify only the next route's path. Background publication persists its
/// cursor between calls instead of holding the live source lock for a tree walk.
pub(super) fn next_local(db: &Connection, after: Option<&str>) -> Result<Option<Route>> {
    next_page(db, "routes", after, true)
}
fn next_page(
    db: &Connection,
    name: &str,
    after: Option<&str>,
    local: bool,
) -> Result<Option<Route>> {
    fn search(
        db: &Connection,
        edge: &Edge,
        level: Option<u16>,
        after: Option<&str>,
        local: bool,
    ) -> Result<Option<Route>> {
        if local && edge.page.origin.is_some() {
            return Err(invalid("snapshot references external routing pages"));
        }
        match checked_child(db, edge, level)? {
            Node::Leaf { rows } => Ok(rows
                .into_iter()
                .find(|r| after.is_none_or(|a| r.lower.as_str() > a))),
            Node::Branch { level, children } => {
                let start = after
                    .map(|a| {
                        children
                            .partition_point(|r| r.lower.as_str() <= a)
                            .saturating_sub(1)
                    })
                    .unwrap_or(0);
                for child in &children[start..] {
                    if let Some(row) = search(db, child, Some(level - 1), after, local)? {
                        return Ok(Some(row));
                    }
                }
                Ok(None)
            }
        }
    }
    match head(db, name)? {
        Some(edge) => search(db, &edge, None, after, local),
        None if local => Err(invalid("snapshot has no routing head")),
        None => Ok(None),
    }
}
pub(super) fn oversized(db: &Connection, threshold: i64) -> Result<Option<Route>> {
    let Some(mut edge) = head(db, "routes")? else {
        return Ok(None);
    };
    let mut level = None;
    loop {
        let node = checked_child(db, &edge, level)?;
        if edge.largest <= threshold {
            return Ok(None);
        }
        match node {
            Node::Leaf { rows } => {
                return Ok(rows.into_iter().find(|r| r.splittable_bytes() > threshold))
            }
            Node::Branch { level: l, children } => {
                edge = children
                    .into_iter()
                    .find(|r| r.largest > threshold)
                    .ok_or_else(|| invalid("missing oversized route"))?;
                level = Some(l - 1);
            }
        }
    }
}
fn save_nodes(db: &Connection, node: Node, inline: bool) -> Result<Vec<Edge>> {
    match node {
        Node::Leaf { mut rows } if rows.len() > FANOUT => {
            let right = rows.split_off(rows.len() / 2);
            Ok(vec![
                write_node(db, &Node::Leaf { rows })?,
                write_node(db, &Node::Leaf { rows: right })?,
            ])
        }
        Node::Branch {
            level,
            mut children,
        } if children.len() > FANOUT => {
            let right = children.split_off(children.len() / 2);
            Ok(vec![
                write_node(db, &Node::Branch { level, children })?,
                write_node(
                    db,
                    &Node::Branch {
                        level,
                        children: right,
                    },
                )?,
            ])
        }
        node => Ok(vec![if inline {
            inline_node(db, &node)?
        } else {
            write_node(db, &node)?
        }]),
    }
}
pub(super) fn put(db: &Connection, name: &str, row: Route) -> Result<()> {
    fn insert(
        db: &Connection,
        edge: &Edge,
        expected: Option<u16>,
        row: Route,
        inline: bool,
    ) -> Result<(u16, Vec<Edge>)> {
        let mut node = checked_child(db, edge, expected)?;
        let level = node.level();
        match &mut node {
            Node::Leaf { rows } => {
                let i = rows.partition_point(|r| r.lower < row.lower);
                if rows.get(i).is_some_and(|r| r.lower == row.lower) {
                    rows[i] = row;
                } else {
                    rows.insert(i, row);
                }
            }
            Node::Branch { level, children } => {
                let i = children
                    .partition_point(|r| r.lower <= row.lower)
                    .saturating_sub(1);
                let (_, replacements) = insert(db, &children[i], Some(*level - 1), row, false)?;
                children.splice(i..=i, replacements);
            }
        }
        Ok((level, save_nodes(db, node, inline)?))
    }
    let root = match head(db, name)? {
        Some(edge) => {
            let (level, mut replacements) = insert(db, &edge, None, row, true)?;
            if replacements.len() == 1 {
                replacements.remove(0)
            } else {
                inline_node(
                    db,
                    &Node::Branch {
                        level: level
                            .checked_add(1)
                            .ok_or_else(|| invalid("invalid routing depth"))?,
                        children: replacements,
                    },
                )?
            }
        }
        None => inline_node(db, &Node::Leaf { rows: vec![row] })?,
    };
    publish(db, name, Some(root))
}
pub(super) fn remove(db: &Connection, name: &str, key: &str) -> Result<()> {
    fn delete(
        db: &Connection,
        edge: Edge,
        expected: Option<u16>,
        key: &str,
        inline: bool,
    ) -> Result<Option<Edge>> {
        let mut node = checked_child(db, &edge, expected)?;
        match &mut node {
            Node::Leaf { rows } => {
                rows.retain(|r| r.lower != key);
                if rows.is_empty() {
                    return Ok(None);
                }
            }
            Node::Branch { level, children } => {
                let i = children
                    .partition_point(|r| r.lower.as_str() <= key)
                    .saturating_sub(1);
                let replacement = delete(db, children[i].clone(), Some(*level - 1), key, false)?;
                children.splice(i..=i, replacement);
                if children.is_empty() {
                    return Ok(None);
                }
            }
        }
        Ok(Some(if inline {
            inline_node(db, &node)?
        } else {
            write_node(db, &node)?
        }))
    }
    let root = match head(db, name)? {
        Some(edge) => delete(db, edge, None, key, true)?,
        None => None,
    };
    publish(db, name, root)
}
pub(super) fn clear(db: &Connection, name: &str) -> Result<()> {
    publish(db, name, None)
}
pub(super) fn rebase_snapshot(db: &Connection, source: &Connection) -> Result<()> {
    let origin = root_directory(source)?
        .canonicalize()
        .map_err(error)?
        .to_str()
        .ok_or_else(|| invalid("invalid routing source path"))?
        .to_owned();
    let mut edge = head(db, "routes")?.ok_or_else(|| invalid("missing snapshot routing head"))?;
    if edge.page.origin.is_some() {
        return Err(invalid(
            "snapshot source references an external routing store",
        ));
    }
    edge.page.origin = Some(origin);
    publish(db, "routes", Some(edge))?;
    clear(db, "retired")
}
pub(super) fn verify_local(db: &Connection) -> Result<()> {
    fn walk(db: &Connection, edge: &Edge, level: Option<u16>) -> Result<()> {
        if edge.page.origin.is_some() {
            return Err(invalid("snapshot references external routing pages"));
        }
        if let Node::Branch { level, children } = checked_child(db, edge, level)? {
            for child in children {
                walk(db, &child, Some(level - 1))?;
            }
        }
        Ok(())
    }
    walk(
        db,
        &head(db, "routes")?.ok_or_else(|| invalid("snapshot has no routing head"))?,
        None,
    )
}

#[cfg(test)]
thread_local! { static READ_PAGES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, Connection) {
        let directory =
            std::env::temp_dir().join(format!("paperclip-routing-{}", uuid::Uuid::new_v4()));
        private_directory(&directory).unwrap();
        let path = directory.join("root.sqlite");
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).unwrap();
        let db = Connection::open(path).unwrap();
        initialize(&db).unwrap();
        db.execute_batch("CREATE TABLE receipt_backup(singleton INTEGER PRIMARY KEY); CREATE TABLE receipt_prepare(singleton INTEGER PRIMARY KEY);").unwrap();
        (directory, db)
    }
    fn row(id: usize) -> Route {
        Route {
            lower: format!("range-{id:08}"),
            file: format!("root.sqlite.receipts/{id}.sqlite"),
            records: 2,
            bytes: (id + 1) as i64,
            fingerprint: vec![id as u8; 32],
        }
    }
    #[test]
    fn routing_root_subdivides_and_reads_one_path_after_thousands_of_ranges() {
        let (directory, mut db) = fixture();
        let tx = db.transaction().unwrap();
        for i in 0..1200 {
            put(&tx, "routes", row(i)).unwrap();
        }
        tx.commit().unwrap();
        let edge = head(&db, "routes").unwrap().unwrap();
        let height = checked_child(&db, &edge, None).unwrap().level();
        assert!(
            height >= 2,
            "test must split the routing root, not only leaves"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM receipt_routing_heads", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(
            db.query_row("SELECT length(root) FROM receipt_routing_heads", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
                < 32768
        );
        for id in [0, 599, 1199] {
            READ_PAGES.with(|n| n.set(0));
            assert_eq!(exact(&db, "routes", &row(id).lower).unwrap(), Some(row(id)));
            assert_eq!(READ_PAGES.with(|n| n.get()), height as usize + 1);
        }
        assert_eq!(oversized(&db, 1199).unwrap(), Some(row(1199)));
        let mut cursor = None;
        for id in 0..1200 {
            READ_PAGES.with(|n| n.set(0));
            let found = next_local(&db, cursor.as_deref()).unwrap().unwrap();
            assert_eq!(found, row(id));
            assert!(READ_PAGES.with(|n| n.get()) <= 2 * (height as usize + 1));
            cursor = Some(found.lower);
        }
        assert_eq!(next(&db, "routes", cursor.as_deref()).unwrap(), None);
        drop(db);
        let db = Connection::open(directory.join("root.sqlite")).unwrap();
        assert_eq!(exact(&db, "routes", &row(0).lower).unwrap(), Some(row(0)));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn root_rollback_preserves_exact_routes_and_missing_pages_are_not_misses() {
        let (directory, mut db) = fixture();
        for i in 0..80 {
            put(&db, "routes", row(i)).unwrap();
        }
        let before = head(&db, "routes").unwrap().unwrap();
        {
            let tx = db.transaction().unwrap();
            for i in 80..160 {
                put(&tx, "routes", row(i)).unwrap();
            }
            // Crash/rollback before the root transaction commits.
        }
        assert_eq!(head(&db, "routes").unwrap().unwrap().page, before.page);
        assert_eq!(exact(&db, "routes", &row(0).lower).unwrap(), Some(row(0)));
        assert_eq!(exact(&db, "routes", &row(159).lower).unwrap(), None);
        let Node::Branch { children, .. } = read_node(&db, &before.page).unwrap() else {
            panic!("root did not subdivide");
        };
        let path = page_path(&db, &children.last().unwrap().page, false).unwrap();
        fs::write(&path, b"changed routing node").unwrap();
        assert!(exact(&db, "routes", &row(159).lower).is_err());
        fs::remove_file(&path).unwrap();
        assert!(exact(&db, "routes", &row(159).lower).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn immutable_snapshot_root_survives_writes_and_becomes_independent_before_publication() {
        let (source_directory, source) = fixture();
        let (target_directory, target) = fixture();
        for i in 0..80 {
            put(&source, "routes", row(i)).unwrap();
        }
        publish(&target, "routes", head(&source, "routes").unwrap()).unwrap();
        rebase_snapshot(&target, &source).unwrap();
        assert!(verify_local(&target).is_err());
        assert!(next_local(&target, None).is_err());
        for i in 80..120 {
            put(&source, "routes", row(i)).unwrap();
        }
        assert_eq!(exact(&target, "routes", &row(119).lower).unwrap(), None);
        for i in 0..80 {
            let mut expected = row(i);
            expected.file = format!("root.sqlite.receipts/copied-{i}.sqlite");
            assert_eq!(
                exact(&target, "routes", &row(i).lower).unwrap(),
                Some(row(i))
            );
            put(&target, "routes", expected).unwrap();
            if i == 39 {
                assert!(next_local(&target, Some(&row(78).lower)).is_err());
            }
        }
        verify_local(&target).unwrap();
        drop(source);
        fs::remove_dir_all(source_directory).unwrap();
        assert_eq!(
            exact(&target, "routes", &row(0).lower)
                .unwrap()
                .unwrap()
                .file,
            "root.sqlite.receipts/copied-0.sqlite"
        );
        drop(target);
        fs::remove_dir_all(target_directory).unwrap();
    }
    #[test]
    fn retired_inventory_is_paged_and_can_release_every_entry() {
        let (directory, db) = fixture();
        for i in 0..80 {
            put(&db, "retired", row(i)).unwrap();
        }
        for i in 0..80 {
            assert_eq!(next(&db, "retired", None).unwrap(), Some(row(i)));
            remove(&db, "retired", &row(i).lower).unwrap();
        }
        assert!(head(&db, "retired").unwrap().is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    fn collect_cycle(db: &Connection, collector: &mut RoutingCollector) -> usize {
        let mut most_reads = 0;
        for _ in 0..100_000 {
            READ_PAGES.with(|n| n.set(0));
            let complete = collector.step(db).unwrap();
            most_reads = most_reads.max(READ_PAGES.with(|n| n.get()));
            if complete {
                return most_reads;
            }
        }
        panic!("routing collection did not finish its bounded steps");
    }

    fn page_count(directory: &Path) -> usize {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    page_count(&path)
                } else {
                    1
                }
            })
            .sum()
    }

    #[test]
    fn collection_reclaims_rolled_back_and_replaced_pages_but_preserves_both_live_trees() {
        let (directory, mut db) = fixture();
        for i in 0..1200 {
            put(&db, "routes", row(i)).unwrap();
        }
        for i in 0..80 {
            put(&db, "retired", row(i + 2000)).unwrap();
        }
        {
            let tx = db.transaction().unwrap();
            for i in 1200..1280 {
                put(&tx, "routes", row(i)).unwrap();
            }
            assert!(RoutingCollector::default().step(&tx).is_err());
        }
        let path = root_directory(&db).unwrap();
        let before = page_count(&path);
        let mut collector = RoutingCollector::default();
        let most_reads = collect_cycle(&db, &mut collector);
        assert!(most_reads <= 7, "one collection step traversed history");
        let after = page_count(&path);
        assert!(
            after < before / 4,
            "obsolete pages were not reclaimed: {before} -> {after}"
        );
        for i in 0..1200 {
            assert_eq!(exact(&db, "routes", &row(i).lower).unwrap(), Some(row(i)));
        }
        for i in 0..80 {
            assert_eq!(
                exact(&db, "retired", &row(i + 2000).lower).unwrap(),
                Some(row(i + 2000))
            );
        }
        assert!(exact(&db, "routes", &row(1279).lower).unwrap().is_none());
        // Restart and a second complete sweep retain precisely the same live pages.
        drop(collector);
        drop(db);
        let db = Connection::open(directory.join("root.sqlite")).unwrap();
        collect_cycle(&db, &mut RoutingCollector::default());
        assert_eq!(page_count(&path), after);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn collection_checks_fresh_roots_and_holds_all_pages_until_backup_finishes() {
        let (directory, db) = fixture();
        let (target_directory, target) = fixture();
        for i in 0..80 {
            put(&db, "routes", row(i)).unwrap();
        }
        publish(&target, "routes", head(&db, "routes").unwrap()).unwrap();
        rebase_snapshot(&target, &db).unwrap();
        db.execute("INSERT INTO receipt_backup VALUES(1)", [])
            .unwrap();
        let mut collector = RoutingCollector::default();
        for i in 0..80 {
            let mut updated = row(i);
            updated.bytes += 1000;
            put(&db, "routes", updated).unwrap();
            assert!(!collector.step(&db).unwrap());
        }
        for i in 0..80 {
            assert_eq!(
                exact(&target, "routes", &row(i).lower).unwrap(),
                Some(row(i))
            );
            // Localize the backup before releasing its pin.
            put(&target, "routes", row(i)).unwrap();
        }
        verify_local(&target).unwrap();
        db.execute("DELETE FROM receipt_backup", []).unwrap();
        // Begin enumeration, then republish historical content. Liveness comes
        // from today's roots, never a stale mark captured when a scan started.
        assert!(!collector.step(&db).unwrap());
        for i in 0..80 {
            put(&db, "routes", row(i)).unwrap();
        }
        collect_cycle(&db, &mut collector);
        for i in 0..80 {
            assert_eq!(exact(&db, "routes", &row(i).lower).unwrap(), Some(row(i)));
        }
        drop(db);
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(
            exact(&target, "routes", &row(0).lower).unwrap(),
            Some(row(0))
        );
        fs::remove_dir_all(target_directory).unwrap();
    }

    #[test]
    fn collection_holds_pending_prepares_and_rejects_corrupt_pages_without_deleting_them() {
        let (directory, db) = fixture();
        for i in 0..80 {
            put(&db, "routes", row(i)).unwrap();
        }
        let obsolete = write_node(
            &db,
            &Node::Leaf {
                rows: vec![row(9000)],
            },
        )
        .unwrap();
        let path = page_path(&db, &obsolete.page, false).unwrap();
        db.execute("INSERT INTO receipt_prepare VALUES(1)", [])
            .unwrap();
        let mut collector = RoutingCollector::default();
        for _ in 0..100 {
            assert!(!collector.step(&db).unwrap());
        }
        assert!(path.exists());
        db.execute("DELETE FROM receipt_prepare", []).unwrap();
        fs::write(&path, b"damaged").unwrap();
        let mut rejected = false;
        for _ in 0..10_000 {
            match collector.step(&db) {
                Err(_) => {
                    rejected = true;
                    break;
                }
                Ok(true) => break,
                Ok(false) => {}
            }
        }
        assert!(rejected);
        assert!(path.exists());
        assert_eq!(exact(&db, "routes", &row(0).lower).unwrap(), Some(row(0)));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn collection_removes_only_owned_temporaries_and_refuses_unknown_roots() {
        let (directory, db) = fixture();
        put(&db, "routes", row(0)).unwrap();
        let page = write_node(&db, &Node::Leaf { rows: vec![row(9)] }).unwrap();
        let path = page_path(&db, &page.page, false).unwrap();
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::hard_link(&path, &temporary).unwrap();
        publish(&db, "future-root", head(&db, "routes").unwrap()).unwrap();
        assert!(RoutingCollector::default().step(&db).is_err());
        assert!(temporary.exists());
        clear(&db, "future-root").unwrap();
        collect_cycle(&db, &mut RoutingCollector::default());
        assert!(!temporary.exists());
        assert!(!path.exists());
        assert_eq!(exact(&db, "routes", &row(0).lower).unwrap(), Some(row(0)));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn collection_never_follows_a_page_symlink() {
        let (directory, db) = fixture();
        put(&db, "routes", row(0)).unwrap();
        let page = write_node(&db, &Node::Leaf { rows: vec![row(9)] }).unwrap();
        let path = page_path(&db, &page.page, false).unwrap();
        let outside = directory.join("preserve-me");
        fs::rename(&path, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        let mut collector = RoutingCollector::default();
        let mut rejected = false;
        for _ in 0..100 {
            if collector.step(&db).is_err() {
                rejected = true;
                break;
            }
        }
        assert!(rejected);
        assert!(fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(outside.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
