"""
Database Backup and Restore
Task 0.7: Automated Backup/Restore Procedures

Provides automated PostgreSQL backup with pg_dump, retention policies,
compression, and restore capabilities.
"""

import os
import logging
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Optional
import gzip
import shutil

from .config import get_db_config, get_backup_config

import logging
logger = logging.getLogger(__name__)



class DatabaseBackup:
    """
    Automated database backup and restore system
    
    Features:
    - pg_dump based backups
    - Optional compression
    - Retention policy management
    - Automatic cleanup of old backups
    - Restore functionality
    - Backup verification
    
    Example:
        backup = DatabaseBackup()
        
        # Create backup
        backup_file = backup.create_backup()
        
        # Restore from backup
        backup.restore_backup(backup_file)
        
        # Cleanup old backups
        backup.cleanup_old_backups()
    """
    
    def __init__(self):
        """Initialize backup system with configuration from environment"""
        self.logger = logging.getLogger(__name__)
        self.db_config = get_db_config()
        self.backup_config = get_backup_config()
        
        # Ensure backup directory exists
        self.backup_dir = Path(self.backup_config['backup_path'])
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        
        self.logger.info(f"DatabaseBackup initialized: {self.backup_dir}")
    
    def create_backup(self, 
                     backup_name: Optional[str] = None,
                     compress: Optional[bool] = None) -> Path:
        """
        Create database backup
        
        Args:
            backup_name: Optional custom backup name (default: timestamp)
            compress: Optional compression flag (default: from config)
            
        Returns:
            Path to backup file
            
        Raises:
            RuntimeError: If backup fails
        """
        # Generate backup filename
        if backup_name is None:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            backup_name = f'optimizer_v3_{timestamp}'
        
        # Determine if compression should be used
        use_compression = compress if compress is not None else self.backup_config['compression']
        
        # Set file extension based on compression
        extension = '.sql.gz' if use_compression else '.sql'
        backup_file = self.backup_dir / f'{backup_name}{extension}'
        
        self.logger.info(f"Creating backup: {backup_file}")
        
        try:
            # Build pg_dump command
            cmd = [
                'pg_dump',
                '-h', self.db_config['host'],
                '-p', str(self.db_config['port']),
                '-U', self.db_config['user'],
                '-d', self.db_config['database'],
                '--verbose',
                '--no-owner',  # Don't include ownership commands
                # --no-acl intentionally removed: role grants (ai_readonly, ai_consultant)
                # must survive restore. Without ACLs in the dump, alembic skips already-
                # recorded grant migrations and the roles end up with no SELECT privileges.
            ]
            
            # Set password in environment
            env = os.environ.copy()
            env['PGPASSWORD'] = self.db_config['password']
            
            # Execute pg_dump
            self.logger.debug(f"Executing pg_dump: {' '.join(cmd[:-2])}...")  # Don't log password
            
            if use_compression:
                # Dump to stdout and compress
                with open(backup_file, 'wb') as f_out:
                    with gzip.GzipFile(fileobj=f_out, mode='wb', compresslevel=9) as gz:
                        process = subprocess.Popen(
                            cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            env=env
                        )
                        
                        # Stream output to compressed file
                        for line in process.stdout:
                            gz.write(line)
                        
                        process.wait()
                        
                        if process.returncode != 0:
                            error_output = process.stderr.read().decode('utf-8')
                            raise RuntimeError(f"pg_dump failed: {error_output}")
            else:
                # Dump directly to file
                cmd.extend(['-f', str(backup_file)])
                
                result = subprocess.run(
                    cmd,
                    env=env,
                    capture_output=True,
                    text=True
                )
                
                if result.returncode != 0:
                    raise RuntimeError(f"pg_dump failed: {result.stderr}")
            
            # Verify backup was created
            if not backup_file.exists():
                raise RuntimeError(f"Backup file was not created: {backup_file}")
            
            file_size = backup_file.stat().st_size
            self.logger.info(f"✅ Backup created successfully: {backup_file} ({file_size:,} bytes)")
            
            return backup_file
            
        except Exception as e:
            self.logger.error(f"❌ Backup failed: {str(e)}")
            # Clean up partial backup file
            if backup_file.exists():
                backup_file.unlink()
            raise
    
    def restore_backup(self, backup_file: Path, drop_existing: bool = False) -> None:
        """
        Restore database from backup
        
        Args:
            backup_file: Path to backup file
            drop_existing: Whether to drop existing database first
            
        Raises:
            FileNotFoundError: If backup file doesn't exist
            RuntimeError: If restore fails
        """
        if not backup_file.exists():
            raise FileNotFoundError(f"Backup file not found: {backup_file}")
        
        self.logger.info(f"Restoring from backup: {backup_file}")
        
        # Confirm restore operation
        self.logger.warning(
            f"⚠️  About to restore database {self.db_config['database']} "
            f"from {backup_file}"
        )
        
        try:
            # Set password in environment
            env = os.environ.copy()
            env['PGPASSWORD'] = self.db_config['password']
            
            # Drop existing database if requested
            if drop_existing:
                self.logger.warning("Dropping existing database...")
                self._drop_database(env)
                self._create_database(env)
            
            # Build restore command
            cmd = [
                'psql',
                '-h', self.db_config['host'],
                '-p', str(self.db_config['port']),
                '-U', self.db_config['user'],
                '-d', self.db_config['database'],
                '--quiet',
            ]
            
            # Handle compressed backups
            if backup_file.suffix == '.gz':
                self.logger.debug("Decompressing backup...")
                with gzip.open(backup_file, 'rb') as f_in:
                    process = subprocess.Popen(
                        cmd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        env=env
                    )
                    
                    # Stream decompressed data to psql
                    for line in f_in:
                        process.stdin.write(line)
                    
                    process.stdin.close()
                    process.wait()
                    
                    if process.returncode != 0:
                        error_output = process.stderr.read().decode('utf-8')
                        raise RuntimeError(f"Restore failed: {error_output}")
            else:
                # Restore from uncompressed file
                cmd.extend(['-f', str(backup_file)])
                
                result = subprocess.run(
                    cmd,
                    env=env,
                    capture_output=True,
                    text=True
                )
                
                if result.returncode != 0:
                    raise RuntimeError(f"Restore failed: {result.stderr}")
            
            self.logger.info("✅ Database restored successfully")
            
        except Exception as e:
            self.logger.error(f"❌ Restore failed: {str(e)}")
            raise
    
    def cleanup_old_backups(self, retention_days: Optional[int] = None) -> List[Path]:
        """
        Remove backups older than retention period
        
        Args:
            retention_days: Optional retention days (default: from config)
            
        Returns:
            List of deleted backup files
        """
        days = retention_days if retention_days is not None else self.backup_config['retention_days']
        cutoff_date = datetime.now() - timedelta(days=days)
        
        self.logger.info(f"Cleaning up backups older than {days} days ({cutoff_date})")
        
        deleted_files = []
        
        # Find all backup files
        for backup_file in self.backup_dir.glob('optimizer_v3_*.sql*'):
            # Get file creation time
            file_time = datetime.fromtimestamp(backup_file.stat().st_ctime)
            
            if file_time < cutoff_date:
                file_size = backup_file.stat().st_size
                self.logger.debug(
                    f"Deleting old backup: {backup_file.name} "
                    f"(created {file_time}, {file_size:,} bytes)"
                )
                backup_file.unlink()
                deleted_files.append(backup_file)
        
        if deleted_files:
            self.logger.info(f"✅ Deleted {len(deleted_files)} old backup(s)")
        else:
            self.logger.info("No old backups to delete")
        
        return deleted_files
    
    def list_backups(self) -> List[Dict[str, Any]]:
        """
        List all available backups
        
        Returns:
            List of backup information dictionaries
        """
        backups = []
        
        for backup_file in sorted(self.backup_dir.glob('optimizer_v3_*.sql*')):
            stat = backup_file.stat()
            
            backups.append({
                'name': backup_file.name,
                'path': backup_file,
                'size': stat.st_size,
                'size_mb': stat.st_size / (1024 * 1024),
                'created': datetime.fromtimestamp(stat.st_ctime),
                'modified': datetime.fromtimestamp(stat.st_mtime),
                'compressed': backup_file.suffix == '.gz'
            })
        
        return backups
    
    def verify_backup(self, backup_file: Path) -> bool:
        """
        Verify backup file integrity
        
        Args:
            backup_file: Path to backup file
            
        Returns:
            True if backup is valid
        """
        if not backup_file.exists():
            self.logger.error(f"Backup file not found: {backup_file}")
            return False
        
        try:
            # For compressed files, try to decompress
            if backup_file.suffix == '.gz':
                with gzip.open(backup_file, 'rb') as f:
                    # Read first few bytes to verify it's valid gzip
                    f.read(1024)
            else:
                # For uncompressed files, check it's readable
                with open(backup_file, 'r') as f:
                    f.read(1024)
            
            self.logger.info(f"✅ Backup verified: {backup_file}")
            return True
            
        except Exception as e:
            self.logger.error(f"❌ Backup verification failed: {str(e)}")
            return False
    
    def get_backup_stats(self) -> Dict[str, Any]:
        """
        Get statistics about backups
        
        Returns:
            Dictionary of backup statistics
        """
        backups = self.list_backups()
        
        total_size = sum(b['size'] for b in backups)
        compressed_count = sum(1 for b in backups if b['compressed'])
        
        stats = {
            'total_backups': len(backups),
            'total_size_bytes': total_size,
            'total_size_mb': total_size / (1024 * 1024),
            'compressed_backups': compressed_count,
            'uncompressed_backups': len(backups) - compressed_count,
            'oldest_backup': min((b['created'] for b in backups), default=None),
            'newest_backup': max((b['created'] for b in backups), default=None),
            'backup_directory': str(self.backup_dir),
            'retention_days': self.backup_config['retention_days']
        }
        
        return stats
    
    def reapply_ai_grants(self) -> None:
        """
        Re-apply all ai_readonly SELECT grants after a restore.

        Call this after restore_backup() when restoring to a DB where the
        ai_readonly role was created by a migration that is already recorded in
        alembic_version (so alembic won't re-run it) but whose GRANT statements
        were not present in the dump (e.g. old dumps taken before the --no-acl
        fix landed).  Safe to call on a live DB as a one-off remediation too.
        """
        _READABLE_TABLES = [
            'strategies', 'strategy_versions', 'strategy_block_versions',
            'strategy_test_results', 'signal_events', 'signal_metrics',
            'backtest_results', 'optimization_runs', 'strategy_variations',
            'ai_recommendations', 'validation_reports',
        ]

        env = os.environ.copy()
        env['PGPASSWORD'] = self.db_config['password']

        def _run(sql: str) -> None:
            result = subprocess.run(
                ['psql', '-h', self.db_config['host'],
                 '-p', str(self.db_config['port']),
                 '-U', self.db_config['user'],
                 '-d', self.db_config['database'],
                 '-c', sql],
                env=env, capture_output=True, text=True
            )
            if result.returncode != 0:
                raise RuntimeError(f"Grant statement failed: {result.stderr.strip()}")

        role_exists = subprocess.run(
            ['psql', '-h', self.db_config['host'],
             '-p', str(self.db_config['port']),
             '-U', self.db_config['user'],
             '-d', self.db_config['database'],
             '-tAc', "SELECT 1 FROM pg_roles WHERE rolname='ai_readonly'"],
            env=env, capture_output=True, text=True
        )
        if role_exists.stdout.strip() != '1':
            self.logger.info("ai_readonly role does not exist — skipping grant reapply")
            return

        _run("GRANT CONNECT ON DATABASE optimizer_v3 TO ai_readonly;")
        _run("GRANT USAGE ON SCHEMA public TO ai_readonly;")
        for table in _READABLE_TABLES:
            check = subprocess.run(
                ['psql', '-h', self.db_config['host'],
                 '-p', str(self.db_config['port']),
                 '-U', self.db_config['user'],
                 '-d', self.db_config['database'],
                 '-tAc', f"SELECT 1 FROM information_schema.tables WHERE table_name='{table}'"],
                env=env, capture_output=True, text=True
            )
            if check.stdout.strip() == '1':
                _run(f"GRANT SELECT ON TABLE {table} TO ai_readonly;")
            else:
                self.logger.debug(f"Table {table} not present — skipping grant")

        self.logger.info("✅ ai_readonly grants reapplied successfully")

    def _drop_database(self, env: Dict[str, str]) -> None:
        """Drop database (internal use only)"""
        cmd = [
            'psql',
            '-h', self.db_config['host'],
            '-p', str(self.db_config['port']),
            '-U', self.db_config['user'],
            '-d', 'postgres',  # Connect to postgres database
            '-c', f"DROP DATABASE IF EXISTS {self.db_config['database']}"
        ]
        
        result = subprocess.run(cmd, env=env, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise RuntimeError(f"Failed to drop database: {result.stderr}")
    
    def _create_database(self, env: Dict[str, str]) -> None:
        """Create database (internal use only)"""
        cmd = [
            'psql',
            '-h', self.db_config['host'],
            '-p', str(self.db_config['port']),
            '-U', self.db_config['user'],
            '-d', 'postgres',  # Connect to postgres database
            '-c', f"CREATE DATABASE {self.db_config['database']}"
        ]
        
        result = subprocess.run(cmd, env=env, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise RuntimeError(f"Failed to create database: {result.stderr}")


# Global backup instance
_backup_instance: Optional[DatabaseBackup] = None


def get_backup_manager() -> DatabaseBackup:
    """
    Get global backup manager instance (singleton pattern)
    
    Returns:
        DatabaseBackup instance
    """
    global _backup_instance
    
    if _backup_instance is None:
        _backup_instance = DatabaseBackup()
    
    return _backup_instance
