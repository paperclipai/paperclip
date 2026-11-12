use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

use crate::durable::{DurableRunnerError, QualifiedLaunchArtifact};
use crate::process_supervisor::VerifiedProcessArtifact;

static TRUSTED_LAUNCH_ROOT: OnceLock<TrustedLaunchRoot> = OnceLock::new();

/// Set once at startup from `--trusted-launch-root`. Without it, every launch
/// artifact is copied into a sealed snapshot and hashed, as before.
pub fn set_trusted_launch_root(root: TrustedLaunchRoot) {
    let _ = TRUSTED_LAUNCH_ROOT.set(root);
}

/// A directory the host asserts is an immutable, digest-pinned image, such as
/// the agent computer's Runner ROM. Runner-owned launch artifacts whose open
/// descriptor lies on that image are executed in place: no sealed copy and no
/// per-launch digest. Anything the root does not admit keeps the sealed copy.
///
/// The assertion is explicit and path-scoped. Admission still proves, from the
/// open descriptor, that the file is inside the root and on a read-only,
/// exec-permitted mount of a filesystem that cannot be written at all (erofs or
/// squashfs). A misconfigured root therefore only loses the speedup.
#[derive(Debug)]
pub struct TrustedLaunchRoot {
    path: PathBuf,
    #[cfg(target_os = "linux")]
    device: u64,
    #[cfg(target_os = "linux")]
    immutable_mount: fn(&File) -> std::io::Result<bool>,
}

impl TrustedLaunchRoot {
    /// Accept a root only when it is absolute, already canonical (no symlink
    /// or `..` component) and itself on an immutable mount.
    pub fn open(path: &Path) -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        {
            Self::open_with_mount_check(path, immutable_exec_mount)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Err("trusted launch roots are supported only on Linux".to_owned())
        }
    }

    #[cfg(target_os = "linux")]
    fn open_with_mount_check(
        path: &Path,
        immutable_mount: fn(&File) -> std::io::Result<bool>,
    ) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("trusted launch root must be an absolute path".to_owned());
        }
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("trusted launch root cannot be resolved: {error}"))?;
        if canonical != path {
            return Err("trusted launch root must not contain symlinks or `..`".to_owned());
        }
        let directory = File::open(&canonical)
            .map_err(|error| format!("trusted launch root cannot be opened: {error}"))?;
        let metadata = directory
            .metadata()
            .map_err(|error| format!("trusted launch root cannot be inspected: {error}"))?;
        if !metadata.is_dir() {
            return Err("trusted launch root must be a directory".to_owned());
        }
        if !immutable_mount(&directory).unwrap_or(false) {
            return Err(
                "trusted launch root is not on a read-only, exec-permitted erofs or squashfs mount"
                    .to_owned(),
            );
        }
        Ok(Self {
            path: canonical,
            device: metadata.dev(),
            immutable_mount,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Decide from the open descriptor alone, never from the name it was
    /// opened by: the kernel's path for the descriptor must lie under the
    /// root, on the root's filesystem, and that mount must be immutable.
    #[cfg(target_os = "linux")]
    fn admits(&self, file: &File) -> Result<(), &'static str> {
        use std::os::fd::AsRawFd;

        let metadata = file.metadata().map_err(|_| "cannot inspect descriptor")?;
        if !metadata.is_file() {
            return Err("not a regular file");
        }
        if metadata.dev() != self.device {
            return Err("not on the trusted root's filesystem");
        }
        let held = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
            .map_err(|_| "cannot resolve descriptor")?;
        if !held.is_absolute()
            || held
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            || !held.starts_with(&self.path)
            || held == self.path
        {
            return Err("outside the trusted root");
        }
        if !(self.immutable_mount)(file).unwrap_or(false) {
            return Err("not on a read-only, exec-permitted erofs or squashfs mount");
        }
        Ok(())
    }
}

/// erofs and squashfs have no write path at all, so a read-only mount of one
/// cannot change underneath an open descriptor, not even through another
/// mount of the same superblock.
#[cfg(target_os = "linux")]
fn immutable_exec_mount(file: &File) -> std::io::Result<bool> {
    use rustix::fs::StatVfsMountFlags;
    const EROFS_SUPER_MAGIC_V1: u32 = 0xE0F5_E1E2;
    const SQUASHFS_MAGIC: u32 = 0x7371_7368;

    let mount = rustix::fs::fstatvfs(file)?;
    if !mount.f_flag.contains(StatVfsMountFlags::RDONLY)
        || mount.f_flag.contains(StatVfsMountFlags::NOEXEC)
    {
        return Ok(false);
    }
    // `f_type` is signed or unsigned, 32 or 64 bits, by architecture. The
    // magic numbers are 32-bit, so compare the low word.
    #[allow(clippy::unnecessary_cast)]
    let filesystem = rustix::fs::fstatfs(file)?.f_type as u32;
    Ok(matches!(filesystem, EROFS_SUPER_MAGIC_V1 | SQUASHFS_MAGIC))
}

/// Who chose an artifact. Only Runner-owned launch-profile artifacts may use
/// the trusted launch root.
#[derive(Clone, Copy)]
enum ArtifactOwner {
    Runner,
    HostAssigned,
}

/// A Runner-owned artifact (provider runtime, sidecar or proxy) pinned by the
/// launch profile. It may run in place from the trusted launch root.
pub fn verify_launch_artifact(
    artifact: &QualifiedLaunchArtifact,
    label: &str,
) -> Result<VerifiedProcessArtifact, DurableRunnerError> {
    verify_owned(
        artifact,
        label,
        false,
        ArtifactOwner::Runner,
        TRUSTED_LAUNCH_ROOT.get(),
    )
}

/// The executable counterpart of [`verify_launch_artifact`].
pub fn verify_executable_launch_artifact(
    artifact: &QualifiedLaunchArtifact,
    label: &str,
) -> Result<VerifiedProcessArtifact, DurableRunnerError> {
    verify_owned(
        artifact,
        label,
        true,
        ArtifactOwner::Runner,
        TRUSTED_LAUNCH_ROOT.get(),
    )
}

/// A host-assigned executable, such as a stdio MCP server. It is always
/// snapshotted and hashed, whatever the trusted launch root.
pub fn verify_assigned_executable_launch_artifact(
    artifact: &QualifiedLaunchArtifact,
    label: &str,
) -> Result<VerifiedProcessArtifact, DurableRunnerError> {
    verify_owned(
        artifact,
        label,
        true,
        ArtifactOwner::HostAssigned,
        TRUSTED_LAUNCH_ROOT.get(),
    )
}

fn verify_owned(
    artifact: &QualifiedLaunchArtifact,
    label: &str,
    executable: bool,
    owner: ArtifactOwner,
    configured_root: Option<&TrustedLaunchRoot>,
) -> Result<VerifiedProcessArtifact, DurableRunnerError> {
    let trusted_root = match owner {
        ArtifactOwner::Runner => configured_root,
        ArtifactOwner::HostAssigned => None,
    };
    verify_launch_artifact_with_role(artifact, label, executable, trusted_root)
}

fn verify_launch_artifact_with_role(
    artifact: &QualifiedLaunchArtifact,
    label: &str,
    executable: bool,
    trusted_root: Option<&TrustedLaunchRoot>,
) -> Result<VerifiedProcessArtifact, DurableRunnerError> {
    let source_metadata = fs::symlink_metadata(&artifact.path).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to inspect qualified {label}: {error}"))
    })?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err(DurableRunnerError::invalid(format!(
            "qualified {label} must be a regular file, not a symlink"
        )));
    }
    #[cfg(unix)]
    if source_metadata.permissions().mode() & 0o022 != 0 {
        return Err(DurableRunnerError::invalid(format!(
            "qualified {label} must not be group- or world-writable"
        )));
    }

    let canonical = fs::canonicalize(&artifact.path).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to resolve qualified {label}: {error}"))
    })?;
    let canonical_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        DurableRunnerError::invalid(format!(
            "failed to inspect resolved qualified {label}: {error}"
        ))
    })?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_file() {
        return Err(DurableRunnerError::invalid(format!(
            "resolved qualified {label} must be a regular file"
        )));
    }
    let file = File::open(&canonical).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to open qualified {label}: {error}"))
    })?;
    let opened_metadata = file.metadata().map_err(|error| {
        DurableRunnerError::invalid(format!("failed to identify qualified {label}: {error}"))
    })?;
    if !same_file(&canonical_metadata, &opened_metadata) {
        return Err(DurableRunnerError::invalid(format!(
            "qualified {label} changed while it was opened"
        )));
    }
    #[cfg(target_os = "linux")]
    if let Some(root) = trusted_root {
        match root.admits(&file) {
            // The image is immutable and pinned by digest where it is
            // deployed, so re-hashing it here could only repeat that check.
            Ok(()) => {
                return Ok(VerifiedProcessArtifact::in_place_on_trusted_root(
                    canonical, file,
                ))
            }
            Err(reason) => eprintln!(
                "paperclip-runnerd: qualified {label} is not admitted by trusted launch root {} ({reason}); using a sealed snapshot",
                root.path.display()
            ),
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = trusted_root;
    let snapshot = if executable {
        VerifiedProcessArtifact::snapshot_verified_executable(canonical, file, &artifact.sha256)
    } else {
        VerifiedProcessArtifact::snapshot_verified(canonical, file, &artifact.sha256)
    };
    snapshot.map_err(|error| DurableRunnerError::invalid(error.to_string()))
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.is_file() == right.is_file()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::time::{SystemTime, UNIX_EPOCH};

    // A writable temporary directory stands in for the ROM. These checks
    // replace only the mount-type probe; path, device and descriptor checks
    // stay real.
    fn immutable(_: &File) -> std::io::Result<bool> {
        Ok(true)
    }

    fn writable(_: &File) -> std::io::Result<bool> {
        Ok(false)
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "paperclip-trusted-launch-root-{name}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(root.join("rom/libexec")).unwrap();
            fs::create_dir_all(root.join("outside")).unwrap();
            Self {
                root: fs::canonicalize(root).unwrap(),
            }
        }

        fn rom(&self) -> PathBuf {
            self.root.join("rom")
        }

        fn artifact(&self, path: PathBuf, bytes: &[u8]) -> QualifiedLaunchArtifact {
            fs::write(&path, bytes).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            QualifiedLaunchArtifact {
                path,
                sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn sealed(artifact: &VerifiedProcessArtifact) -> bool {
        let file = artifact.held_file();
        let link = fs::read_link(format!(
            "/proc/self/fd/{}",
            std::os::fd::AsRawFd::as_raw_fd(file)
        ))
        .unwrap();
        file.metadata().unwrap().nlink() == 0
            && link
                .to_string_lossy()
                .starts_with("/memfd:paperclip-verified-launch")
    }

    fn same_inode(artifact: &VerifiedProcessArtifact, path: &Path) -> bool {
        let held = artifact.held_file().metadata().unwrap();
        let named = fs::metadata(path).unwrap();
        held.dev() == named.dev() && held.ino() == named.ino()
    }

    #[test]
    fn an_artifact_under_an_immutable_trusted_root_runs_in_place_without_a_digest() {
        let fixture = Fixture::new("hit");
        let root = TrustedLaunchRoot::open_with_mount_check(&fixture.rom(), immutable).unwrap();
        let mut artifact = fixture.artifact(fixture.rom().join("libexec/node"), b"node");
        // The trusted path does not re-hash: a wrong expected digest still
        // admits, because the image itself is the pinned authority.
        artifact.sha256 = "sha256:not-rehashed".to_owned();

        let verified =
            verify_launch_artifact_with_role(&artifact, "test", true, Some(&root)).unwrap();

        assert!(!sealed(&verified));
        assert!(same_inode(&verified, &artifact.path));
    }

    #[test]
    fn an_artifact_outside_the_trusted_root_keeps_the_sealed_snapshot() {
        let fixture = Fixture::new("outside");
        let root = TrustedLaunchRoot::open_with_mount_check(&fixture.rom(), immutable).unwrap();
        let artifact = fixture.artifact(fixture.root.join("outside/node"), b"node");

        let verified =
            verify_launch_artifact_with_role(&artifact, "test", true, Some(&root)).unwrap();
        assert!(sealed(&verified));

        let mut tampered = artifact.clone();
        tampered.sha256 = "sha256:wrong".to_owned();
        assert!(verify_launch_artifact_with_role(&tampered, "test", true, Some(&root)).is_err());
    }

    #[test]
    fn a_sibling_with_the_root_as_a_name_prefix_is_outside_the_root() {
        let fixture = Fixture::new("prefix");
        fs::create_dir_all(fixture.root.join("rom2")).unwrap();
        let root = TrustedLaunchRoot::open_with_mount_check(&fixture.rom(), immutable).unwrap();
        let artifact = fixture.artifact(fixture.root.join("rom2/node"), b"node");

        let verified =
            verify_launch_artifact_with_role(&artifact, "test", false, Some(&root)).unwrap();
        assert!(sealed(&verified));
    }

    #[test]
    fn a_root_that_is_not_read_only_falls_back_to_the_sealed_snapshot() {
        let fixture = Fixture::new("writable");
        // The real probe rejects a writable temporary directory at startup.
        assert!(TrustedLaunchRoot::open(&fixture.rom()).is_err());

        // A mount that stops being immutable after startup is rejected per
        // artifact, from the open descriptor.
        let mut root = TrustedLaunchRoot::open_with_mount_check(&fixture.rom(), immutable).unwrap();
        root.immutable_mount = writable;
        let artifact = fixture.artifact(fixture.rom().join("libexec/node"), b"node");
        let verified =
            verify_launch_artifact_with_role(&artifact, "test", true, Some(&root)).unwrap();
        assert!(sealed(&verified));

        let mut tampered = artifact.clone();
        tampered.sha256 = "sha256:wrong".to_owned();
        assert!(verify_launch_artifact_with_role(&tampered, "test", true, Some(&root)).is_err());
    }

    #[test]
    fn the_real_mount_probe_rejects_a_writable_filesystem() {
        let fixture = Fixture::new("probe");
        let file = File::open(fixture.artifact(fixture.rom().join("node"), b"node").path).unwrap();
        assert!(!immutable_exec_mount(&file).unwrap());
    }

    #[test]
    fn symlink_and_parent_escapes_from_the_root_fall_back() {
        let fixture = Fixture::new("escape");
        let root = TrustedLaunchRoot::open_with_mount_check(&fixture.rom(), immutable).unwrap();
        let outside = fixture.artifact(fixture.root.join("outside/node"), b"node");

        // A directory symlink inside the root that points outside it.
        std::os::unix::fs::symlink(fixture.root.join("outside"), fixture.rom().join("escape"))
            .unwrap();
        let through_link = QualifiedLaunchArtifact {
            path: fixture.rom().join("escape/node"),
            sha256: outside.sha256.clone(),
        };
        let verified =
            verify_launch_artifact_with_role(&through_link, "test", true, Some(&root)).unwrap();
        assert!(sealed(&verified));

        // A `..` path that starts under the root and leaves it.
        let dotted = QualifiedLaunchArtifact {
            path: fixture.rom().join("libexec/../../outside/node"),
            sha256: outside.sha256.clone(),
        };
        let verified =
            verify_launch_artifact_with_role(&dotted, "test", true, Some(&root)).unwrap();
        assert!(sealed(&verified));

        // A final-component symlink is still refused outright.
        std::os::unix::fs::symlink(&outside.path, fixture.rom().join("libexec/link")).unwrap();
        let linked = QualifiedLaunchArtifact {
            path: fixture.rom().join("libexec/link"),
            sha256: outside.sha256,
        };
        assert!(verify_launch_artifact_with_role(&linked, "test", true, Some(&root)).is_err());
    }

    #[test]
    fn a_root_must_be_absolute_canonical_and_a_directory() {
        let fixture = Fixture::new("root-shape");
        std::os::unix::fs::symlink(fixture.rom(), fixture.root.join("alias")).unwrap();
        for candidate in [
            PathBuf::from("relative/rom"),
            fixture.root.join("alias"),
            fixture.rom().join("libexec/.."),
            fixture.root.join("missing"),
        ] {
            assert!(
                TrustedLaunchRoot::open_with_mount_check(&candidate, immutable).is_err(),
                "{}",
                candidate.display()
            );
        }
        let file = fixture
            .artifact(fixture.rom().join("libexec/node"), b"node")
            .path;
        assert!(TrustedLaunchRoot::open_with_mount_check(&file, immutable).is_err());
    }

    #[test]
    fn without_a_trusted_root_launch_artifacts_are_sealed_and_hashed() {
        let fixture = Fixture::new("absent");
        let artifact = fixture.artifact(fixture.rom().join("libexec/node"), b"node");

        assert!(TRUSTED_LAUNCH_ROOT.get().is_none());
        assert!(sealed(&verify_launch_artifact(&artifact, "test").unwrap()));
        assert!(sealed(
            &verify_executable_launch_artifact(&artifact, "test").unwrap()
        ));

        let mut tampered = artifact;
        tampered.sha256 = "sha256:wrong".to_owned();
        assert!(verify_launch_artifact(&tampered, "test").is_err());
    }

    #[test]
    fn host_assigned_executables_ignore_the_trusted_root() {
        let fixture = Fixture::new("assigned");
        let root = TrustedLaunchRoot::open_with_mount_check(&fixture.rom(), immutable).unwrap();
        let artifact = fixture.artifact(fixture.rom().join("libexec/mcp"), b"mcp");

        // The same configured root admits this file for a Runner-owned launch.
        let runner =
            verify_owned(&artifact, "test", true, ArtifactOwner::Runner, Some(&root)).unwrap();
        assert!(!sealed(&runner));

        // A host-assigned executable at the same path stays sealed and hashed.
        let assigned = verify_owned(
            &artifact,
            "test",
            true,
            ArtifactOwner::HostAssigned,
            Some(&root),
        )
        .unwrap();
        assert!(sealed(&assigned));
        let mut tampered = artifact;
        tampered.sha256 = "sha256:wrong".to_owned();
        assert!(verify_owned(
            &tampered,
            "test",
            true,
            ArtifactOwner::HostAssigned,
            Some(&root),
        )
        .is_err());
    }
}
