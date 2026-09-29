//! Collect obsolete index pages without a history-sized mark set or inventory.
//! A page contains its immutable lower key and level, so two current-root point
//! lookups establish reachability. The caller holds the partition operation lock
//! through that check and unlink. An online backup pins every source page until
//! its independent copy is published. Receipt contents are never collected here.
use super::*;

#[derive(Default)]
pub(crate) struct RoutingCollector {
    // At most three open directory iterators: root, two-digit prefix, leaf.
    // Restarting loses only scan progress, never a deletion authorization.
    directories: Vec<(PathBuf, fs::ReadDir)>,
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A corrupt current path is an error, never evidence that a page is garbage.
fn reachable(db: &Connection, name: &str, candidate: &Edge, level: u16) -> Result<bool> {
    let Some(mut edge) = head(db, name)? else {
        if name == "routes" {
            return Err(invalid("missing routing authority prevents collection"));
        }
        return Ok(false);
    };
    let mut expected = None;
    loop {
        if edge.page.origin.is_some() {
            return Err(invalid("collection requires local routing authority"));
        }
        let node = checked_child(db, &edge, expected)?;
        if node.level() <= level {
            return Ok(node.level() == level
                && edge.page.inline.is_none()
                && edge.page.sha == candidate.page.sha);
        }
        let Node::Branch { level, children } = node else {
            unreachable!("leaf level is zero");
        };
        let Some(next) = children
            .into_iter()
            .rev()
            .find(|child| child.lower <= candidate.lower)
        else {
            return Ok(false);
        };
        edge = next;
        expected = Some(level - 1);
    }
}

impl RoutingCollector {
    /// Inspect at most one directory entry and one bounded page. Returns true at
    /// the end of a scan. Caller must recover pending writes first and retain
    /// PartitionLock; no current-root transaction may span this call.
    pub(crate) fn step(&mut self, db: &Connection) -> Result<bool> {
        if !db.is_autocommit() {
            return Err(invalid(
                "routing collection cannot run inside a transaction",
            ));
        }
        let held: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM receipt_backup) OR EXISTS(SELECT 1 FROM receipt_prepare)",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        if held {
            return Ok(false);
        }
        let unknown_head: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM receipt_routing_heads WHERE name NOT IN ('routes','retired'))",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        if unknown_head {
            return Err(invalid("unknown routing root prevents collection"));
        }
        if self.directories.is_empty() {
            let root = root_directory(db)?;
            crate::durable::verify_private_directory(&root)?;
            let entries = fs::read_dir(&root).map_err(error)?;
            self.directories.push((root, entries));
            return Ok(false);
        }
        let depth = self.directories.len();
        let (_, entries) = self.directories.last_mut().unwrap();
        let Some(entry) = entries.next() else {
            self.directories.pop();
            return Ok(self.directories.is_empty());
        };
        let entry = entry.map_err(error)?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| invalid("invalid routing directory entry"))?;
        let path = entry.path();
        // A different store handle may have collected this entry between steps.
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(error(e)),
        };
        if depth < 3 {
            if !hex(name, 2) {
                return Err(invalid("invalid routing directory prefix"));
            }
            crate::durable::verify_private_directory(&path)?;
            self.directories
                .push((path.clone(), fs::read_dir(path).map_err(error)?));
            return Ok(false);
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(invalid("routing collection encountered a nonregular page"));
        }
        let parent = path.parent().unwrap();
        let prefix = parent
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let suffix = parent.file_name().unwrap().to_str().unwrap();
        if let Some(stem) = name.strip_suffix(".json").filter(|s| hex(s, 60)) {
            let page = PageRef {
                sha: format!("{prefix}{suffix}{stem}"),
                inline: None,
                origin: None,
            };
            let node = read_node(db, &page)?;
            let candidate = node.edge(page);
            if reachable(db, "routes", &candidate, node.level())?
                || reachable(db, "retired", &candidate, node.level())?
            {
                return Ok(false);
            }
        } else {
            // Only our exact unpublished temporary filename can be reclaimed.
            // Writers hold the same lock, so none can still be writing it.
            let Some((stem, temporary)) = name.split_once('.') else {
                return Err(invalid("invalid routing page filename"));
            };
            if !hex(stem, 60)
                || !temporary.strip_suffix(".tmp").is_some_and(|id| {
                    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
                })
            {
                return Err(invalid("invalid routing temporary filename"));
            }
            drop(crate::durable::open_private_regular_file(&path).map_err(error)?);
        }
        fs::remove_file(&path).map_err(error)?;
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        Ok(false)
    }
}
