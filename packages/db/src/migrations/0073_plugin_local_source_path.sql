-- Track the source path of local-path plugin installs separately from the
-- runtime location. After 0073, a plugin's `package_path` continues to point
-- at the runtime location (managed directory inside ~/.paperclip/plugins/),
-- but `local_source_path` records where the install was originally read from
-- so the Reinstall flow can re-read and re-copy the source after a rebuild.
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS local_source_path text;
