# Kotlin Best Practices — Code Patterns

> This file is referenced by SKILL.md. Read it when writing Kotlin code and you need the exact syntax.

## Null Safety Patterns

```kotlin
// NEVER — banned, pre-commit hook rejects it
val x = foo!!.bar

// GOOD — safe call + elvis
val x = foo?.bar ?: defaultValue

// GOOD — explicit null check (smart cast after)
if (foo == null) return error.left()
foo.bar  // smart cast, no ?. needed

// GOOD — let for null-safe chains
user?.let { generateTokens(it, provider) }
  ?: return AuthError.AUTHENTICATION_FAILED.asException().left()
```

## Either Error Handling

```kotlin
// Managers return Either — never throw
suspend fun findById(id: UUID): Either<ClientException, UserResponse> {
  val entity = userRepository.byId(id)
    ?: return ClientError.USER_NOT_FOUND.asException().left()
  return UserResponse.from(entity).right()
}

// Controllers unwrap with .throwOrValue()
@Get("/user")
suspend fun getUser(@QueryValue id: UUID): UserResponse {
  return userManager.findById(id).throwOrValue()
}
```

## Enum Usage

```kotlin
// NEVER hardcode strings when an enum exists
val status = "critical"              // WRONG
val status = HealthStatus.CRITICAL.value  // RIGHT

// Define enums with .value
enum class HealthStatus(val value: String) {
  HEALTHY("healthy"),
  AT_RISK("at_risk"),
  CRITICAL("critical");

  companion object {
    fun fromValue(v: String) = entries.find { it.value == v }
  }
}
```

## Exposed ORM Patterns

```kotlin
// Table — extend UUIDTable, use text() not varchar()
object UsersTable : UUIDTable("users") {
  val email = text("email")
  val displayName = text("display_name").nullable()
  val createdAt = timestamp("created_at")
  val updatedAt = timestamp("updated_at").nullable()
  val deletedAt = timestamp("deleted_at").nullable()
}

// Query — ALWAYS check deletedAt.isNull()
fun byId(id: UUID): UserEntity? {
  return transaction(db.replica) {
    UsersTable
      .selectAll()
      .where { (UsersTable.id eq id) and UsersTable.deletedAt.isNull() }
      .singleOrNull()
      ?.let { convert(it) }
  }
}

// Soft delete — NEVER hard delete
fun deleteById(id: UUID): UserEntity? {
  return transaction(db.primary) {
    UsersTable.update(
      where = { (UsersTable.id eq id) and UsersTable.deletedAt.isNull() }
    ) {
      it[deletedAt] = Instant.now()
      it[updatedAt] = Instant.now()
    }
    UsersTable.selectAll()
      .where { UsersTable.id eq id }
      .singleOrNull()
      ?.let { convert(it) }
  }
}
```

## Transaction Rules

```kotlin
// Reads use replica, writes use primary
val user = transaction(db.replica) { userRepository.byId(id) }
val saved = transaction(db.primary) { userRepository.insert(entity) }

// Multiple writes in one transaction
transaction(db.primary) {
  val user = userRepository.insert(userEntity)
  profileRepository.insert(profileEntity)
  // all succeed or all rollback
}
```

## Conversion Pattern

```kotlin
// Companion object from() on Response DTOs
data class UserResponse(
  val id: UUID,
  val email: String
) {
  companion object {
    fun from(entity: UserEntity) = UserResponse(
      id = entity.id,
      email = entity.email
    )
  }
}

// Use in manager
return UserResponse.from(entity).right()
```
