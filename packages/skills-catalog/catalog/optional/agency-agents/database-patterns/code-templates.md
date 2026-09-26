# Database Patterns — Code Templates

> This file is referenced by SKILL.md. Read it when writing migrations, table objects, entities, or repositories.

## SQL Migration Template

```sql
CREATE TABLE {table_name} (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- business columns here, always TEXT not VARCHAR
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT,
  -- standard columns (required on ALL tables)
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

-- Updated_at trigger (required)
CREATE TRIGGER set_{table_name}_updated_at
  BEFORE UPDATE ON {table_name}
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Indexes (include deleted_at IS NULL for soft delete)
CREATE INDEX idx_{table_name}_status
  ON {table_name} (status)
  WHERE deleted_at IS NULL;
```

## Exposed Table Object

```kotlin
object EmployeesTable : UUIDTable("employees") {
  val name = text("name")
  val email = text("email")
  val status = text("status").default(EmployeeStatus.ACTIVE.value)
  val description = text("description").nullable()
  val createdAt = timestamp("created_at")
  val updatedAt = timestamp("updated_at").nullable()
  val deletedAt = timestamp("deleted_at").nullable()
}
```

## Entity Data Class

```kotlin
data class EmployeeEntity(
  override val id: UUID = UUID.randomUUID(),
  val name: String,
  val email: String,
  val status: String,
  val description: String?,
  override val createdAt: Instant,
  override val updatedAt: Instant?,
  override val deletedAt: Instant?
) : Entity<Instant>
```

## Repository Pattern

```kotlin
interface EmployeeRepository {
  fun insert(entity: EmployeeEntity): EmployeeEntity
  fun update(id: UUID, name: String?, status: String?): EmployeeEntity?
  fun byId(id: UUID): EmployeeEntity?
  fun byIds(ids: List<UUID>): List<EmployeeEntity>
  fun deleteById(id: UUID): EmployeeEntity?
}

class DefaultEmployeeRepository(
  private val db: DatabaseContext
) : EmployeeRepository {

  override fun byId(id: UUID): EmployeeEntity? {
    return transaction(db.replica) {
      EmployeesTable
        .selectAll()
        .where { (EmployeesTable.id eq id) and EmployeesTable.deletedAt.isNull() }
        .singleOrNull()
        ?.let { convert(it) }
    }
  }

  override fun deleteById(id: UUID): EmployeeEntity? {
    return transaction(db.primary) {
      EmployeesTable.update(
        where = { (EmployeesTable.id eq id) and EmployeesTable.deletedAt.isNull() }
      ) {
        it[deletedAt] = Instant.now()
        it[updatedAt] = Instant.now()
      }
      // Return the soft-deleted entity
      EmployeesTable
        .selectAll()
        .where { EmployeesTable.id eq id }
        .singleOrNull()
        ?.let { convert(it) }
    }
  }

  private fun convert(row: ResultRow) = EmployeeEntity(
    id = row[EmployeesTable.id].value,
    name = row[EmployeesTable.name],
    email = row[EmployeesTable.email],
    status = row[EmployeesTable.status],
    description = row[EmployeesTable.description],
    createdAt = row[EmployeesTable.createdAt],
    updatedAt = row[EmployeesTable.updatedAt],
    deletedAt = row[EmployeesTable.deletedAt]
  )
}
```
