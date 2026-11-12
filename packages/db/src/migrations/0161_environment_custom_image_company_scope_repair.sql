-- No-op retained for migration ordering compatibility.
--
-- This branch previously carried a company-scope repair for environment custom
-- images, but origin/master intentionally restored custom images to the
-- instance-scoped environment model in 0127. Reapplying company scope here
-- contradicts the checked-in Drizzle schema and can fail against cloned
-- multi-company dev databases.
SELECT 1;
