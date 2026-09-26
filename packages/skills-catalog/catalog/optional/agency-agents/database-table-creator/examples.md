# Database Table Creator - Code Examples

This file contains actual code patterns extracted from the codebase. **Follow these patterns exactly**.

---

## Kotlin Table Object Pattern

**File**: `app/module-repository/src/main/kotlin/com/yourcompany/postgresql/table/UserTable.kt`

```kotlin
package com.yourcompany.postgresql.table

import org.jetbrains.exposed.dao.id.UUIDTable
import org.jetbrains.exposed.sql.javatime.timestamp
import java.time.Instant

object UserTable : UUIDTable("users") {  // ✓ MUST extend UUIDTable
  // Business columns
  val email = text("email").nullable()  // ✓ Use text() not varchar()
  val emailVerified = bool("email_verified").default(false)
  val displayName = text("display_name").nullable()
  val avatarUrl = text("avatar_url").nullable()
  val authId = text("auth_id").nullable()
  val provider = text("provider").nullable()
  val status = text("status").default("active")
  val referralSource = text("referral_source").default("OTHER")
  val password = text("password").nullable()
  val userRoleType = text("user_role_type").nullable()
  val userType = text("user_type").nullable()
  val userStatusType = text("user_status_type").nullable()
  val companyId = uuid("company_id").nullable()

  // Required timestamp columns
  val createdAt = timestamp("created_at").clientDefault { Instant.now() }
  val updatedAt = timestamp("updated_at").nullable()
  val deletedAt = timestamp("deleted_at").nullable()
}
```

**Key points**:
- Extends `UUIDTable` (provides UUID primary key)
- Uses `text()` for all string columns (matches SQL TEXT type)
- Uses `.nullable()` for optional fields
- Standard timestamps: createdAt (non-null), updatedAt (nullable), deletedAt (nullable)
- Column names match SQL exactly (snake_case)

---

## Entity Data Class Pattern

**File**: `app/module-repository/src/main/kotlin/com/yourcompany/postgresql/entity/UserEntity.kt`

```kotlin
package com.yourcompany.postgresql.entity

import com.yourcompany.postgresql.constant.ReferralSource
import com.yourcompany.postgresql.constant.UserRoleType
import com.yourcompany.postgresql.constant.UserStatus
import com.yourcompany.postgresql.constant.UserStatusType
import com.yourcompany.postgresql.constant.UserType
import java.time.Instant
import java.util.UUID

data class UserEntity(  // ✓ Use data class
  override val id: UUID = UUID.randomUUID(),  // ✓ Override from Entity
  val email: String? = null,
  val emailVerified: Boolean = false,
  val displayName: String? = null,
  val avatarUrl: String? = null,
  val authId: String? = null,
  val provider: String? = null,
  val status: UserStatus? = null,  // ✓ Use enum types when appropriate
  val referralSource: ReferralSource? = null,
  val password: String? = null,
  val role: UserRoleType? = null,
  val type: UserType? = null,
  val businessStatus: UserStatusType? = null,
  val companyId: UUID? = null,
  override val createdAt: Instant = Instant.now(),  // ✓ Override from Entity
  override val updatedAt: Instant? = null,  // ✓ Override from Entity
  override val deletedAt: Instant? = null  // ✓ Override from Entity
) : Entity<Instant>  // ✓ MUST implement Entity<Instant>
```

**Key points**:
- Must be a `data class`
- Must implement `Entity<Instant>`
- Must override: id, createdAt, updatedAt, deletedAt
- Use `String` for TEXT columns
- Use `UUID` for UUID columns
- Use `Instant` for TIMESTAMP columns
- Use enums for status/type columns
- Nullable fields have `? = null` defaults

---

## Repository Interface Pattern

```kotlin
package com.yourcompany.postgresql.repository

import com.yourcompany.postgresql.entity.UserEntity
import java.util.UUID

interface UserRepository {
  // Standard CRUD operations
  fun insert(entity: UserEntity): UserEntity
  fun update(
    id: UUID,
    email: String? = null,
    displayName: String? = null,
    // ... other fields
  ): UserEntity?

  fun byId(id: UUID): UserEntity?
  fun byIds(ids: List<UUID>): List<UserEntity>

  // Custom query methods
  fun byEmail(email: String): UserEntity?
  fun byAuthId(authId: String): UserEntity?

  // Soft delete operations
  fun deleteById(id: UUID): UserEntity?
  fun restoreById(id: UUID): UserEntity?
}
```

**Key points**:
- Use domain-specific method names (`byEmail`, not `findByEmail`)
- Return entity or null (don't throw exceptions)
- Update accepts optional fields
- Include soft delete and restore methods

---

## Repository Implementation Pattern

```kotlin
package com.yourcompany.postgresql.repository

import com.yourcompany.database.DatabaseContext
import com.yourcompany.postgresql.entity.UserEntity
import com.yourcompany.postgresql.table.UserTable
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.Instant
import java.util.UUID

class DefaultUserRepository(
  private val db: DatabaseContext  // ✓ Constructor injection
) : UserRepository {

  override fun insert(entity: UserEntity): UserEntity {
    return transaction(db.primary) {  // ✓ Use db.primary for writes
      UserTable.insert {
        it[id] = entity.id
        it[email] = entity.email
        it[emailVerified] = entity.emailVerified
        it[displayName] = entity.displayName
        // ... map all fields
        it[createdAt] = entity.createdAt
        it[updatedAt] = entity.updatedAt
        it[deletedAt] = entity.deletedAt
      }
      entity
    }
  }

  override fun update(
    id: UUID,
    email: String?,
    displayName: String?
  ): UserEntity? {
    return transaction(db.primary) {
      val updated = UserTable.update(
        where = {
          UserTable.id eq id and  // ✓ Filter by id
          UserTable.deletedAt.isNull()  // ✓ CRITICAL: Filter soft deletes
        }
      ) {
        email?.let { value -> it[UserTable.email] = value }
        displayName?.let { value -> it[UserTable.displayName] = value }
        // updatedAt automatically set by database trigger
      }
      if (updated > 0) byId(id) else null  // ✓ Return updated entity or null
    }
  }

  override fun byId(id: UUID): UserEntity? {
    return transaction(db.replica) {  // ✓ Use db.replica for reads
      UserTable
        .selectAll()
        .where { UserTable.id eq id }
        .andWhere { UserTable.deletedAt.isNull() }  // ✓ CRITICAL: Filter soft deletes
        .map { convert(it) }
        .singleOrNull()  // ✓ Return null if not found
    }
  }

  override fun byEmail(email: String): UserEntity? {
    return transaction(db.replica) {
      UserTable
        .selectAll()
        .where { UserTable.email eq email }
        .andWhere { UserTable.deletedAt.isNull() }  // ✓ ALWAYS filter soft deletes
        .map { convert(it) }
        .singleOrNull()
    }
  }

  override fun deleteById(id: UUID): UserEntity? {
    return transaction(db.primary) {
      val updated = UserTable.update(
        where = {
          UserTable.id eq id and
          UserTable.deletedAt.isNull()  // ✓ Only delete active records
        }
      ) {
        it[deletedAt] = Instant.now()  // ✓ Soft delete: set timestamp
      }
      if (updated > 0) {
        // Return the soft-deleted entity (need to query without deletedAt filter)
        UserTable
          .selectAll()
          .where { UserTable.id eq id }
          .map { convert(it) }
          .singleOrNull()
      } else null
    }
  }

  override fun restoreById(id: UUID): UserEntity? {
    return transaction(db.primary) {
      val updated = UserTable.update(
        where = {
          UserTable.id eq id and
          UserTable.deletedAt.isNotNull()  // ✓ Only restore deleted records
        }
      ) {
        it[deletedAt] = null  // ✓ Restore: clear timestamp
      }
      if (updated > 0) byId(id) else null
    }
  }

  // ✓ Private helper for mapping
  private fun convert(row: ResultRow): UserEntity {
    return UserEntity(
      id = row[UserTable.id].value,  // ✓ UUID field needs .value
      email = row[UserTable.email],
      emailVerified = row[UserTable.emailVerified],
      displayName = row[UserTable.displayName],
      avatarUrl = row[UserTable.avatarUrl],
      authId = row[UserTable.authId],
      provider = row[UserTable.provider],
      // Map enums properly
      status = row[UserTable.status]?.let { UserStatus.valueOf(it) },
      referralSource = row[UserTable.referralSource]?.let { ReferralSource.valueOf(it) },
      password = row[UserTable.password],
      role = row[UserTable.userRoleType]?.let { UserRoleType.valueOf(it) },
      type = row[UserTable.userType]?.let { UserType.valueOf(it) },
      businessStatus = row[UserTable.userStatusType]?.let { UserStatusType.valueOf(it) },
      companyId = row[UserTable.companyId],
      createdAt = row[UserTable.createdAt],
      updatedAt = row[UserTable.updatedAt],
      deletedAt = row[UserTable.deletedAt]
    )
  }
}
```

**Critical patterns**:
- Use `transaction(db.primary)` for all writes (insert, update, delete)
- Use `transaction(db.replica)` for all reads
- **ALWAYS** include `.andWhere { deletedAt.isNull() }` in queries
- Soft delete sets `deletedAt = Instant.now()`
- Return null when record not found (don't throw)
- Private `convert()` method for ResultRow → Entity mapping
- NO `!!` operators anywhere

---

## Repository Factory Bean Pattern

**File**: `app/module-repository/src/main/kotlin/com/yourcompany/runtime/factory/RepositoryFactory.kt`

```kotlin
package com.yourcompany.runtime.factory

import com.yourcompany.database.DatabaseContext
import com.yourcompany.postgresql.repository.*
import io.micronaut.context.annotation.Factory
import jakarta.inject.Singleton

@Factory
class RepositoryFactory {

  @Singleton
  fun provideUserRepository(db: DatabaseContext): UserRepository {
    return DefaultUserRepository(db)
  }

  @Singleton
  fun provideContactRepository(db: DatabaseContext): ContactRepository {
    return DefaultContactRepository(db)
  }

  // Add new repository beans here
}
```

**Key points**:
- Use `@Factory` class annotation
- Use `@Singleton` method annotation
- Return interface type, not implementation
- Accept `DatabaseContext` parameter
- Method name: `provide{TableName}Repository`

---

## Repository Test Pattern

```kotlin
package com.yourcompany.postgresql.repository

import assertk.assertThat
import assertk.assertions.*
import com.yourcompany.postgresql.entity.UserEntity
import com.yourcompany.postgresql.constant.UserStatus
import io.micronaut.test.extensions.junit5.annotation.MicronautTest
import jakarta.inject.Inject
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.UUID

@MicronautTest(environments = ["test"])  // ✓ Test environment
class DefaultUserRepositoryTest : AbstractRepositoryTest() {  // ✓ Extend base class

  @Inject
  lateinit var repository: UserRepository  // ✓ Inject interface

  @BeforeEach
  fun setup() {
    database.primary.truncateAllTables()  // ✓ Clean state
  }

  @Test
  fun `insert - creates user successfully`() {
    val entity = dummyUserEntity()

    val result = repository.insert(entity)

    assertThat(result.id).isEqualTo(entity.id)
    assertThat(result.email).isEqualTo(entity.email)
  }

  @Test
  fun `update - updates selected fields only`() {
    val entity = repository.insert(dummyUserEntity())
    val newEmail = "newemail@example.com"

    val updated = repository.update(
      id = entity.id,
      email = newEmail
    )

    assertThat(updated).isNotNull()
    assertThat(updated?.email).isEqualTo(newEmail)
    assertThat(updated?.displayName).isEqualTo(entity.displayName)  // Unchanged
  }

  @Test
  fun `byId - returns entity when exists`() {
    val entity = repository.insert(dummyUserEntity())

    val result = repository.byId(entity.id)

    assertThat(result).isNotNull()
    assertThat(result?.id).isEqualTo(entity.id)
  }

  @Test
  fun `byId - returns null when not exists`() {
    val randomId = UUID.randomUUID()

    val result = repository.byId(randomId)

    assertThat(result).isNull()
  }

  @Test
  fun `byId - returns null when soft deleted`() {
    val entity = repository.insert(dummyUserEntity())
    repository.deleteById(entity.id)  // Soft delete

    val result = repository.byId(entity.id)

    assertThat(result).isNull()  // ✓ Soft deleted records not returned
  }

  @Test
  fun `deleteById - soft deletes entity`() {
    val entity = repository.insert(dummyUserEntity())

    val deleted = repository.deleteById(entity.id)

    assertThat(deleted).isNotNull()
    assertThat(deleted?.deletedAt).isNotNull()  // ✓ Has timestamp
    assertThat(repository.byId(entity.id)).isNull()  // ✓ Not found in queries
  }

  @Test
  fun `restoreById - restores soft deleted entity`() {
    val entity = repository.insert(dummyUserEntity())
    repository.deleteById(entity.id)

    val restored = repository.restoreById(entity.id)

    assertThat(restored).isNotNull()
    assertThat(restored?.deletedAt).isNull()  // ✓ Timestamp cleared
    assertThat(repository.byId(entity.id)).isNotNull()  // ✓ Found in queries
  }

  // ✓ Test helper with defaults
  private fun dummyUserEntity(
    id: UUID = UUID.randomUUID(),
    email: String = "${UUID.randomUUID()}@test.com"
  ) = UserEntity(
    id = id,
    email = email,
    emailVerified = false,
    displayName = "Test User",
    status = UserStatus.ACTIVE
  )
}
```

**Required tests** (minimum):
1. Insert happy path
2. Update modifies fields correctly
3. byId returns entity when exists
4. byId returns null when not exists
5. byId returns null when soft deleted ← **Critical for soft delete verification**
6. deleteById soft deletes entity
7. restoreById restores soft deleted entity

**Test patterns**:
- Extend `AbstractRepositoryTest`
- Use `@MicronautTest(environments = ["test"])`
- Clean database in `@BeforeEach`
- Create dummy entity helpers with random data
- Use AssertJ assertions (`assertk.assertThat`)
- Test soft delete behavior thoroughly

---

## Anti-Patterns to NEVER Use

❌ **Wrong: Using `Table` instead of `UUIDTable`**
```kotlin
object UserTable : Table("users")  // WRONG - missing UUID primary key
```

✓ **Correct: Use `UUIDTable`**
```kotlin
object UserTable : UUIDTable("users")  // CORRECT
```

---

❌ **Wrong: Forgetting soft delete filter**
```kotlin
fun byId(id: UUID): UserEntity? {
  return transaction(db.replica) {
    UserTable
      .selectAll()
      .where { UserTable.id eq id }  // WRONG - includes soft deleted
      .map { convert(it) }
      .singleOrNull()
  }
}
```

✓ **Correct: Always filter soft deletes**
```kotlin
fun byId(id: UUID): UserEntity? {
  return transaction(db.replica) {
    UserTable
      .selectAll()
      .where { UserTable.id eq id }
      .andWhere { UserTable.deletedAt.isNull() }  // CORRECT
      .map { convert(it) }
      .singleOrNull()
  }
}
```

---

❌ **Wrong: Using `!!` operator**
```kotlin
val user = repository.byId(id)!!  // FORBIDDEN - will fail pre-commit hook
```

✓ **Correct: Use safe calls**
```kotlin
val user = repository.byId(id)
  ?: return ClientError.USER_NOT_FOUND.asException().left()
```

---

❌ **Wrong: Hard delete**
```kotlin
fun deleteById(id: UUID): Boolean {
  return transaction(db.primary) {
    UserTable.deleteWhere { id eq userId } > 0  // WRONG - permanent deletion
  }
}
```

✓ **Correct: Soft delete**
```kotlin
fun deleteById(id: UUID): UserEntity? {
  return transaction(db.primary) {
    UserTable.update({ id eq userId and deletedAt.isNull() }) {
      it[deletedAt] = Instant.now()  // CORRECT - soft delete
    }
    if (updated > 0) byId(id) else null
  }
}
```

---

## Summary

**Always follow these patterns exactly**:
1. Table extends `UUIDTable`
2. Entity implements `Entity<Instant>`
3. Use `text()` not `varchar()`
4. Filter `deletedAt.isNull()` in ALL queries
5. Use `transaction(db.primary)` for writes
6. Use `transaction(db.replica)` for reads
7. Never use `!!` operator
8. Soft delete only (set deletedAt timestamp)
9. Return null when not found
10. Test soft delete behavior thoroughly

**These patterns are non-negotiable and must be followed exactly.**
