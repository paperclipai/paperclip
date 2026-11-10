use super::*;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

struct Fixture {
    directory: PathBuf,
    profile: AcpxLaunchProfile,
}

impl Fixture {
    fn new(label: &str, write: bool) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-acpx-launch-artifacts-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let command = directory.join("node");
        let sidecar = directory.join("sidecar.cjs");
        let profile = AcpxLaunchProfile {
            candidate_admission: None,
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: command.clone(),
            args: vec![sidecar.to_string_lossy().into_owned()],
            artifacts: vec![
                qualified(&command, b"qualified node"),
                qualified(&sidecar, b"qualified sidecar"),
            ],
        };
        let fixture = Self { directory, profile };
        if write {
            fixture.write_qualified();
        }
        fixture
    }

    fn command(&self) -> PathBuf {
        self.profile.command.clone()
    }

    fn sidecar(&self) -> PathBuf {
        self.directory.join("sidecar.cjs")
    }

    fn write_qualified(&self) {
        write(&self.command(), b"qualified node", 0o700);
        write(&self.sidecar(), b"qualified sidecar", 0o600);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn qualified(path: &Path, contents: &[u8]) -> QualifiedLaunchArtifact {
    QualifiedLaunchArtifact {
        path: path.to_owned(),
        sha256: format!("sha256:{:x}", Sha256::digest(contents)),
    }
}

fn write(path: &Path, contents: &[u8], mode: u32) {
    let _ = fs::remove_file(path);
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn await_background(artifacts: &AcpxLaunchArtifacts) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match &*artifacts.state.lock().unwrap() {
            State::Verifying(handle) if !handle.is_finished() => {}
            State::Verifying(_) => return,
            _ => panic!("boot verification did not start"),
        }
        assert!(
            Instant::now() < deadline,
            "boot verification did not finish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn launches_from_boot_snapshots_after_the_source_files_change() {
    let fixture = Fixture::new("boot", true);
    let artifacts = AcpxLaunchArtifacts::verify_in_background(Some(&fixture.profile));
    await_background(&artifacts);
    write(&fixture.command(), b"replaced node", 0o700);
    write(&fixture.sidecar(), b"replaced sidecar", 0o600);

    let first = artifacts.verified(&fixture.profile).unwrap();
    let second = artifacts.verified(&fixture.profile).unwrap();

    assert_eq!(first.len(), 2);
    assert!(first.contains_key(&fixture.command()));
    assert!(first.contains_key(&fixture.sidecar()));
    assert_eq!(second.len(), 2);
}

#[test]
fn falls_back_to_synchronous_verification_when_boot_verification_fails() {
    let fixture = Fixture::new("fallback", false);
    let artifacts = AcpxLaunchArtifacts::verify_in_background(Some(&fixture.profile));
    await_background(&artifacts);
    assert!(artifacts.verified(&fixture.profile).is_err());

    fixture.write_qualified();

    assert_eq!(artifacts.verified(&fixture.profile).unwrap().len(), 2);
}

#[test]
fn verifies_a_different_profile_instead_of_reusing_snapshots() {
    let fixture = Fixture::new("profile", true);
    let artifacts = AcpxLaunchArtifacts::default();
    artifacts.verified(&fixture.profile).unwrap();

    let mut drifted = fixture.profile.clone();
    drifted.artifacts[1] = qualified(&fixture.sidecar(), b"another sidecar");

    assert!(artifacts.verified(&drifted).is_err());
    assert_eq!(artifacts.verified(&fixture.profile).unwrap().len(), 2);
}

#[test]
fn rejects_repeated_artifact_paths() {
    let fixture = Fixture::new("repeated", true);
    let mut repeated = fixture.profile.clone();
    repeated.artifacts.push(repeated.artifacts[1].clone());

    let error = AcpxLaunchArtifacts::default()
        .verified(&repeated)
        .err()
        .unwrap();

    assert!(error.to_string().contains("repeats an artifact path"));
}

#[test]
fn starts_no_boot_verification_without_a_launch_profile() {
    let artifacts = AcpxLaunchArtifacts::verify_in_background(None);
    assert!(matches!(&*artifacts.state.lock().unwrap(), State::Idle));
}
