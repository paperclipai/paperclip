# API Design — Code Patterns

> This file is referenced by SKILL.md. Read it when implementing actual endpoints.

## Controller Template

```kotlin
@ExecuteOn(TaskExecutors.IO)    // REQUIRED for suspend
@Validated
@Controller("/api/v1/admin")
@Secured(OAuthSecurityRule.ADMIN)
class EmployeeController(
  private val employeeManager: EmployeeManager  // Managers ONLY
) {
  @Get("/employee")
  suspend fun getEmployee(@QueryValue id: UUID): EmployeeResponse {
    return employeeManager.findById(id).throwOrValue()
  }

  @Get("/employees")
  suspend fun listEmployees(
    @QueryValue page: Int?,
    @QueryValue limit: Int?,
    @QueryValue status: String?
  ): EmployeeListResponse {
    return employeeManager.list(
      page = page ?: 1,
      limit = (limit ?: 20).coerceAtMost(100),
      status = status
    ).throwOrValue()
  }
}
```

## Response Models

All in `module-client/response/{domain}/`:

```kotlin
data class EmployeeResponse(
  val id: UUID,
  val name: String,
  val email: String,
  val status: String,
  val createdAt: Instant
) {
  companion object {
    fun from(entity: EmployeeEntity) = EmployeeResponse(
      id = entity.id,
      name = entity.name,
      email = entity.email,
      status = entity.status,
      createdAt = entity.createdAt
    )
  }
}

data class EmployeeListResponse(
  val items: List<EmployeeResponse>,
  val total: Int,
  val page: Int,
  val limit: Int,
  val hasMore: Boolean
)
```

## Pagination Pattern

```kotlin
override suspend fun list(
  page: Int,
  limit: Int,
  status: String?
): Either<ClientException, EmployeeListResponse> {
  val offset = (page - 1) * limit

  val (items, total) = transaction(db.replica) {
    val query = EmployeesTable
      .selectAll()
      .where { EmployeesTable.deletedAt.isNull() }

    if (status != null) {
      query.andWhere { EmployeesTable.status eq status }
    }

    val total = query.count().toInt()
    val items = query
      .orderBy(EmployeesTable.createdAt to SortOrder.DESC)
      .limit(limit)
      .offset(offset.toLong())
      .map { convert(it) }

    items to total
  }

  return EmployeeListResponse(
    items = items.map { EmployeeResponse.from(it) },
    total = total,
    page = page,
    limit = limit,
    hasMore = (page * limit) < total
  ).right()
}
```

## Error Pattern

```kotlin
// Not found
val entity = repository.byId(id)
  ?: return ClientError.NOT_FOUND.asException().left()

// Already exists
val existing = repository.byEmail(email)
if (existing != null) {
  return ClientError.ALREADY_EXISTS.asException().left()
}

// Validation
if (request.name.isBlank()) {
  return ClientError.INVALID_INPUT.asException("Name is required").left()
}
```

## Factory Bean

```kotlin
@Factory
class EmployeeManagerFactory {
  @Singleton
  fun provideEmployeeManager(
    employeeRepository: EmployeeRepository,
    db: DatabaseContext
  ): EmployeeManager {
    return DefaultEmployeeManager(employeeRepository, db)
  }
}
```
