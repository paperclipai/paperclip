# Error Handling Guide - Either Type Usage

How to use Arrow's `Either` type for error handling in the platform.

---

## Either Basics

```kotlin
sealed class Either<out L, out R>
```

- **Left** = Error case
- **Right** = Success case

Type signature: `Either<ErrorType, SuccessType>`

---

## Core Pattern

### Manager Returns Either

```kotlin
interface ProjectManager {
  suspend fun byId(id: UUID): Either<ClientException, ProjectResponse>
}
```

### Controller Unwraps Either

```kotlin
@Get("/project")
suspend fun getProject(@QueryValue id: UUID): ProjectResponse {
  return projectManager.byId(id).throwOrValue()
}
```

---

## Creating Either Values

### Success (Right)

```kotlin
import arrow.core.right

fun getUser(id: UUID): Either<ClientException, UserResponse> {
  val user = repository.byId(id) ?: return error...
  return UserResponse.from(user).right()
}
```

### Error (Left)

```kotlin
import arrow.core.left

fun getUser(id: UUID): Either<ClientException, UserResponse> {
  val user = repository.byId(id)
    ?: return ClientError.USER_NOT_FOUND.asException().left()
  return UserResponse.from(user).right()
}
```

---

## Common Patterns

### Pattern 1: Null Check with Error

```kotlin
override suspend fun byId(id: UUID): Either<ClientException, ProjectResponse> {
  val entity = projectRepository.byId(id)
    ?: return ClientError.PROJECT_NOT_FOUND.asException().left()
  return ProjectResponse.from(entity, ownerName).right()
}
```

### Pattern 2: Multiple Validations

```kotlin
override suspend fun update(
  id: UUID,
  email: String?
): Either<ClientException, UserResponse> {
  val existing = userRepository.byId(id)
    ?: return ClientError.USER_NOT_FOUND.asException().left()

  if (email != null && email != existing.email) {
    val duplicate = userRepository.byEmail(email)
    if (duplicate != null) {
      return ClientError.EMAIL_ALREADY_IN_USE.asException().left()
    }
  }

  val updated = userRepository.update(id, email)
    ?: return ClientError.USER_NOT_FOUND.asException().left()

  return UserResponse.from(updated).right()
}
```

### Pattern 3: Transaction with Multiple Operations

```kotlin
override suspend fun reassignProject(
  projectId: UUID,
  newOwnerId: UUID
): Either<ClientException, ProjectResponse> {
  val project = projectRepository.byId(projectId)
    ?: return ClientError.PROJECT_NOT_FOUND.asException().left()

  val newOwner = employeeRepository.byId(newOwnerId)
    ?: return ClientError.EMPLOYEE_NOT_FOUND.asException().left()

  val updated = transaction(db.primary) {
    projectRepository.update(projectId, ownerEmployeeId = newOwnerId)
  } ?: return ClientError.PROJECT_NOT_FOUND.asException().left()

  return ProjectResponse.from(updated, newOwner.name).right()
}
```

---

## ClientError Enum

Error types are in `app/module-exception/`:

```kotlin
enum class ClientError(
  override val status: HttpStatus,
  override val code: Int,
  override val message: String
) : Error {
  USER_NOT_FOUND(HttpStatus.NOT_FOUND, 3001, "User not found"),
  PROJECT_NOT_FOUND(HttpStatus.NOT_FOUND, 4110, "Project not found"),
  EMPLOYEE_NOT_FOUND(HttpStatus.NOT_FOUND, 4105, "Employee not found"),
  // ...
}
```

Usage:
```kotlin
ClientError.USER_NOT_FOUND.asException().left()
ClientError.USER_NOT_FOUND.asException("Custom message").left()
```

### HTTP Status Mapping

The exception handler maps errors to HTTP status codes automatically:
- `*_NOT_FOUND` -> 404 Not Found
- `EMAIL_ALREADY_IN_USE` -> 409 Conflict
- `INVALID_CREDENTIALS` -> 401 Unauthorized
- Validation errors -> 400 Bad Request

---

## Controller Layer

### throwOrValue()

```kotlin
@Get("/project")
suspend fun getProject(@QueryValue id: UUID): ProjectResponse {
  return projectManager.byId(id).throwOrValue()
  // Returns ProjectResponse if Right
  // Throws ClientException if Left
}
```

---

## Common Mistakes

**Wrong: Throwing in manager**
```kotlin
override suspend fun byId(id: UUID): Either<ClientException, ProjectResponse> {
  val entity = projectRepository.byId(id)
    ?: throw NotFoundException("Not found")
}
```

**Correct: Return Left**
```kotlin
override suspend fun byId(id: UUID): Either<ClientException, ProjectResponse> {
  val entity = projectRepository.byId(id)
    ?: return ClientError.PROJECT_NOT_FOUND.asException().left()
  return ProjectResponse.from(entity, ownerName).right()
}
```

---

**Wrong: Using !!**
```kotlin
val entity = repository.byId(id)!!
```

**Correct: Safe null handling**
```kotlin
val entity = repository.byId(id)
  ?: return ClientError.NOT_FOUND.asException().left()
```

---

**Wrong: Returning Either from controller**
```kotlin
@Get("/project")
suspend fun getProject(@QueryValue id: UUID): Either<ClientException, ProjectResponse> {
  return projectManager.byId(id)
}
```

**Correct: Unwrap with throwOrValue**
```kotlin
@Get("/project")
suspend fun getProject(@QueryValue id: UUID): ProjectResponse {
  return projectManager.byId(id).throwOrValue()
}
```

---

## Quick Reference

| Scenario | Pattern |
|----------|---------|
| Success | `return value.right()` |
| Not Found | `return ClientError.NOT_FOUND.asException().left()` |
| Already Exists | `return ClientError.ALREADY_EXISTS.asException().left()` |
| Unauthorized | `return ClientError.UNAUTHORIZED.asException().left()` |
| Null Check | `val x = repo.get() ?: return ERROR.asException().left()` |
| Unwrap in Controller | `manager.method().throwOrValue()` |

## Rules

1. Managers always return Either
2. Controllers always use throwOrValue
3. Never throw exceptions in managers
4. Never use `!!` operator
5. Use ClientError enum for errors
