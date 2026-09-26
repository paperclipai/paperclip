# Database Table Creator - Validation Checklist

Use this checklist to validate every database table implementation. **ALL items must pass before completion.**

---

## SQL Migration Validation

### Required Columns
- [ ] Has `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- [ ] Has `created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
- [ ] Has `updated_at TIMESTAMP` (nullable, trigger will set it)
- [ ] Has `deleted_at TIMESTAMP` (nullable, for soft deletes)

### Data Types
- [ ] ALL string columns use `TEXT` (NOT VARCHAR)
- [ ] ALL id columns use `UUID` type
- [ ] ALL timestamp columns use `TIMESTAMP` type
- [ ] Boolean columns use `BOOLEAN` type
- [ ] JSON data uses `JSONB` type

### Constraints
- [ ] NO `FOREIGN KEY` constraints anywhere
- [ ] NO `REFERENCES` clauses anywhere
- [ ] NO `ON DELETE CASCADE` anywhere
- [ ] Primary key constraint exists on id column only

### Indexes
- [ ] ALL unique indexes include `WHERE deleted_at IS NULL`
- [ ] ALL indexes on foreign key columns include `WHERE deleted_at IS NULL`
- [ ] Soft delete index exists: `CREATE INDEX idx_{table}_deleted_at ON {table}(deleted_at) WHERE deleted_at IS NOT NULL`
- [ ] Index naming follows pattern: `idx_{table}_{column}`
- [ ] Unique index naming follows pattern: `idx_{table}_{column}_unique`

### Triggers
- [ ] Update trigger exists for `updated_at` column
- [ ] Trigger format: `CREATE TRIGGER update_{table}_updated_at BEFORE UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION update_updated_at()`

### Migration File
- [ ] File name follows pattern: `{number}-{description}.sql`
- [ ] Has descriptive header comment
- [ ] Migration runs successfully without errors
- [ ] `./gradlew :app:module-repository:flywayMigrate` succeeds
- [ ] `./gradlew :app:module-repository:flywayInfo` shows "Success"

---

## Kotlin Table Object Validation

### Inheritance
- [ ] **CRITICAL**: Extends `UUIDTable` (NOT `Table`)
- [ ] Table name in constructor matches SQL table name exactly
- [ ] Object name follows pattern: `{TableName}Table` (e.g., `UserTable`)

### Column Definitions
- [ ] ALL string columns use `text()` (NOT `varchar()`)
- [ ] UUID columns use `uuid()`
- [ ] Timestamp columns use `timestamp()`
- [ ] Boolean columns use `bool()`
- [ ] Column names match SQL exactly (snake_case)

### Nullability
- [ ] Nullable columns have `.nullable()` modifier
- [ ] Non-null columns do NOT have `.nullable()`
- [ ] `createdAt` is NOT nullable
- [ ] `updatedAt` IS nullable
- [ ] `deletedAt` IS nullable

### Standard Columns
- [ ] Has `createdAt = timestamp("created_at").clientDefault { Instant.now() }`
- [ ] Has `updatedAt = timestamp("updated_at").nullable()`
- [ ] Has `deletedAt = timestamp("deleted_at").nullable()`

### File Location
- [ ] Located in `app/module-repository/src/main/kotlin/com/yourcompany/postgresql/table/`
- [ ] File name is `{TableName}Table.kt`

---

## Entity Data Class Validation

### Class Definition
- [ ] Is a `data class`
- [ ] **CRITICAL**: Implements `Entity<Instant>` interface
- [ ] Name follows pattern: `{TableName}Entity` (e.g., `UserEntity`)

### Required Overrides
- [ ] Overrides `id: UUID` with default `= UUID.randomUUID()`
- [ ] Overrides `createdAt: Instant` with default `= Instant.now()`
- [ ] Overrides `updatedAt: Instant?` with default `= null`
- [ ] Overrides `deletedAt: Instant?` with default `= null`

### Property Types
- [ ] String columns use `String` or `String?` type
- [ ] UUID columns use `UUID` type
- [ ] Timestamp columns use `Instant` or `Instant?` type
- [ ] Boolean columns use `Boolean` type
- [ ] Enum columns use appropriate enum type

### Nullability
- [ ] Nullable database columns have `?` in Kotlin
- [ ] Nullable properties have `= null` default
- [ ] Required database columns do NOT have `?` in Kotlin

### File Location
- [ ] Located in `app/module-repository/src/main/kotlin/com/yourcompany/postgresql/entity/`
- [ ] File name is `{TableName}Entity.kt`

---

## Repository Interface Validation

### Standard Methods
- [ ] Has `insert(entity): Entity` method
- [ ] Has `update(id, ...fields): Entity?` method
- [ ] Has `byId(id): Entity?` method
- [ ] Has `deleteById(id): Entity?` method (soft delete)
- [ ] Has `restoreById(id): Entity?` method (restore soft deleted)

### Method Signatures
- [ ] Return types use entity or null (NOT Optional)
- [ ] Update method parameters are nullable for partial updates
- [ ] Custom query methods follow naming pattern: `by{Column}(value)`

### File Location
- [ ] Located in `app/module-repository/src/main/kotlin/com/yourcompany/postgresql/repository/`
- [ ] File name is `{TableName}Repository.kt`

---

## Repository Implementation Validation

### Class Definition
- [ ] Name follows pattern: `Default{TableName}Repository`
- [ ] Implements repository interface
- [ ] Constructor accepts `DatabaseContext` parameter
- [ ] Constructor uses dependency injection (parameter only)

### Transaction Usage
- [ ] **CRITICAL**: ALL write operations use `transaction(db.primary)`
- [ ] **CRITICAL**: ALL read operations use `transaction(db.replica)`
- [ ] Insert uses `db.primary`
- [ ] Update uses `db.primary`
- [ ] Delete (soft) uses `db.primary`
- [ ] All by* query methods use `db.replica`

### Soft Delete Implementation
- [ ] **CRITICAL**: ALL queries include `.andWhere { deletedAt.isNull() }`
- [ ] `deleteById` sets `deletedAt = Instant.now()` (does NOT hard delete)
- [ ] `deleteById` filters `deletedAt.isNull()` to only delete active records
- [ ] `restoreById` sets `deletedAt = null`
- [ ] `restoreById` filters `deletedAt.isNotNull()` to only restore deleted records

### Null Safety
- [ ] **CRITICAL**: NO `!!` operators anywhere in code
- [ ] Uses `.singleOrNull()` instead of `.single()`
- [ ] Uses safe calls `?.` for nullable access
- [ ] Uses `let` blocks for null-safe operations
- [ ] Returns null when record not found (doesn't throw)

### Helper Methods
- [ ] Has private `convert(row: ResultRow): Entity` method
- [ ] `convert` maps ALL columns from ResultRow to Entity
- [ ] UUID columns access `.value` property: `row[Table.id].value`
- [ ] Enum columns use safe `valueOf()` with null handling

### Return Values
- [ ] Insert returns the inserted entity
- [ ] Update returns updated entity or null
- [ ] Queries return entity or null (or list)
- [ ] Delete/restore return affected entity or null

### File Location
- [ ] Located in `app/module-repository/src/main/kotlin/com/yourcompany/postgresql/repository/`
- [ ] File name is `Default{TableName}Repository.kt`

---

## Repository Factory Bean Validation

### Bean Definition
- [ ] Factory class has `@Factory` annotation
- [ ] Method has `@Singleton` annotation
- [ ] Method name: `provide{TableName}Repository`
- [ ] Returns interface type (not implementation)
- [ ] Accepts `DatabaseContext` parameter
- [ ] Returns new instance: `Default{TableName}Repository(db)`

### File Location
- [ ] Added to `app/module-repository/src/main/kotlin/com/yourcompany/runtime/factory/RepositoryFactory.kt`

---

## Repository Test Validation

### Test Class Setup
- [ ] Extends `AbstractRepositoryTest`
- [ ] Has `@MicronautTest(environments = ["test"])` annotation
- [ ] Name follows pattern: `Default{TableName}RepositoryTest`
- [ ] Injects repository interface using `@Inject`

### Test Coverage (Minimum 7 Tests)
- [ ] Has `insert - creates entity successfully` test
- [ ] Has `update - updates selected fields` test
- [ ] Has `byId - returns entity when exists` test
- [ ] Has `byId - returns null when not exists` test
- [ ] **CRITICAL**: Has `byId - returns null when soft deleted` test
- [ ] Has `deleteById - soft deletes entity` test
- [ ] Has `restoreById - restores soft deleted entity` test

### Test Implementation
- [ ] Uses `@BeforeEach` to truncate tables
- [ ] Has dummy entity helper method with randomized data
- [ ] Uses AssertJ assertions (`assertk.assertThat`)
- [ ] Tests verify soft delete behavior (deletedAt timestamp set)
- [ ] Tests verify soft deleted records not returned in queries
- [ ] Tests verify restore clears deletedAt timestamp

### Test Execution
- [ ] ALL tests pass: `./gradlew :app:module-repository:test --tests "Default{TableName}RepositoryTest"`
- [ ] No compilation errors
- [ ] No runtime errors
- [ ] 100% success rate

### File Location
- [ ] Located in `app/module-repository/src/test/kotlin/com/yourcompany/postgresql/repository/`
- [ ] File name is `Default{TableName}RepositoryTest.kt`

---

## Compilation & Build Validation

- [ ] `./gradlew clean build -x test` succeeds
- [ ] `./gradlew :app:module-repository:test` succeeds
- [ ] `./gradlew ktlintCheck` passes (no style violations)
- [ ] No `!!` operators detected (would fail pre-commit hook)
- [ ] No compilation warnings related to new code
- [ ] Application starts successfully

---

## Common Mistakes Checklist

### SQL Mistakes
- [ ] ❌ NOT using VARCHAR instead of TEXT
- [ ] ❌ NOT using foreign key constraints
- [ ] ❌ NOT forgetting WHERE clause in indexes
- [ ] ❌ NOT using hard delete instead of soft delete
- [ ] ❌ NOT forgetting update trigger

### Kotlin Table Mistakes
- [ ] ❌ NOT extending `Table` instead of `UUIDTable`
- [ ] ❌ NOT using `varchar()` instead of `text()`
- [ ] ❌ NOT mismatching column names with SQL
- [ ] ❌ NOT forgetting `.nullable()` on optional columns

### Entity Mistakes
- [ ] ❌ NOT forgetting to implement `Entity<Instant>`
- [ ] ❌ NOT missing override on id/timestamps
- [ ] ❌ NOT using wrong types (Long instead of UUID, Date instead of Instant)

### Repository Mistakes
- [ ] ❌ NOT forgetting `deletedAt.isNull()` filter in queries
- [ ] ❌ NOT using `!!` operator
- [ ] ❌ NOT hard deleting instead of soft delete
- [ ] ❌ NOT using wrong transaction type (primary vs replica)
- [ ] ❌ NOT missing transaction wrapper
- [ ] ❌ NOT throwing exceptions instead of returning null

### Test Mistakes
- [ ] ❌ NOT missing soft delete test
- [ ] ❌ NOT not cleaning database between tests
- [ ] ❌ NOT using hardcoded test data instead of random
- [ ] ❌ NOT insufficient assertions
- [ ] ❌ NOT tests not running or failing

---

## Final Validation Commands

Run these commands in order to verify everything works:

```bash
# 1. Run migration
./gradlew :app:module-repository:flywayMigrate

# 2. Check migration status
./gradlew :app:module-repository:flywayInfo

# 3. Run code style check
./gradlew ktlintCheck

# 4. Build without tests
./gradlew clean build -x test

# 5. Run repository tests
./gradlew :app:module-repository:test --tests "Default{TableName}RepositoryTest"

# 6. Run all tests
./gradlew test
```

**All commands must succeed with zero errors.**

---

## Success Criteria

✅ **Implementation is complete when**:

1. All checklist items above are checked ✓
2. SQL migration runs successfully
3. All Kotlin files compile without errors
4. All tests pass (100% success rate)
5. No `!!` operators in code
6. All queries filter soft deletes
7. ktlintCheck passes
8. Build succeeds

**If ANY item fails, the implementation is NOT complete.**

---

## Quick Reference: Most Critical Validations

These are the most commonly missed items that MUST be verified:

1. ✅ Table extends `UUIDTable` (not `Table`)
2. ✅ Entity implements `Entity<Instant>`
3. ✅ ALL queries include `deletedAt.isNull()` filter
4. ✅ NO `!!` operators anywhere
5. ✅ SQL uses TEXT (not VARCHAR)
6. ✅ SQL has NO foreign key constraints
7. ✅ ALL indexes have WHERE clause
8. ✅ Soft delete test exists and passes

**These 8 items catch 90% of mistakes. Double-check them carefully.**
