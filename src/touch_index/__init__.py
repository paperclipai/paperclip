"""Touch Index ingestion package.

Maintains touch_index_fr_files and touch_index_bug_files in PostgreSQL,
derived from:
  - FDR (fdr-labelled) issues → git commits referencing the issue ID
  - Bug (title-prefixed) issues closed → git commits referencing the issue ID

Modules
-------
  fr_worker      : FR ingestion worker — process FDR issues and upsert file refs
  bug_worker     : Bug-close ingestion worker — process closed bug issues
  comment_extractor : Extract file paths from Paperclip issue comments
  git_extractor  : Extract touched files from git history for a given issue ID
  db             : PostgreSQL engine factory and health check
  paperclip_client : Thin Paperclip API client
  quality        : Data quality monitoring — coverage, freshness, consistency
"""

from __future__ import annotations
