---
name: "api-endpoint-creator"
description: "Creates RPC-style endpoint following layered architecture (Controller → Manager → Repository). Use when creating new API endpoints or CRUD operations."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/api-endpoint-creator"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "api"
  - "endpoint"
  - "creator"
defaultInstall: false
---
# API Endpoint Creator Skill

Creates complete RPC-style API endpoints following strict layered architecture patterns.

## When to Use

- Creating a new REST API endpoint from scratch
- Adding CRUD operations for a new domain entity
- Setting up the full stack: Controller → Manager → Repository → Tests
- Need a Retrofit client for integration testing

## Process

### 1. Create Response/Request Models

Location: `app/module-client/src/main/kotlin/com/yourcompany/client/response/{domain}/`

```kotlin
package com.yourcompany.client.response.{domain}

import com.yourcompany.postgresql.entity.{Domain}Entity
import java.time.Instant
import java.util.UUID

data class {Domain}Response(
  val id: UUID,
  val name: String,
  val status: String,
  val createdAt: Instant,
  val updatedAt: Instant?
) {
  companion object {
    fun from(entity: {Domain}Entity): {Domain}Response = {Domain}Response(
      id = entity.id,
      name = entity.name,
      status = entity.status,
      createdAt = entity.createdAt,
      updatedAt = entity.updatedAt
    )
  }
}

data class {Domain}ListResponse(
  val items: List<{Domain}Response>,
  val total: Int,
  val page: Int,
  val limit: Int,
  val hasMore: Boolean
)
```

Location: `app/module-client/src/main/kotlin/com/yourcompany/client/request/{domain}/`

```kotlin
package com.yourcompany.client.request.{domain}

data class Create{Domain}Request(
  val name: String,
  val description: String? = null
)

data class Update{Domain}Request(
  val name: String? = null,
  val description: String? = null,
  val status: String? = null
)
```

**Key**: All models in module-client, never in controllers or managers.

### 2. Create Controller

Location: `app/api-application/src/main/kotlin/com/yourcompany/controller/{Domain}Controller.kt`

```kotlin
package com.yourcompany.controller

import com.yourcompany.{domain}.contract.{Domain}Manager
import com.yourcompany.client.request.{domain}.Create{Domain}Request
import com.yourcompany.client.request.{domain}.Update{Domain}Request
import com.yourcompany.client.response.{domain}.{Domain}Response
import com.yourcompany.client.response.{domain}.{Domain}ListResponse
import com.yourcompany.exception.throwOrValue
import io.micronaut.http.annotation.*
import io.micronaut.scheduling.TaskExecutors
import io.micronaut.scheduling.annotation.ExecuteOn
import io.micronaut.security.annotation.Secured
import io.micronaut.validation.Validated
import io.swagger.v3.oas.annotations.tags.Tag
import jakarta.validation.Valid
import java.util.UUID

@ExecuteOn(TaskExecutors.IO)
@Validated
@Controller("/api/v1/{domain}")
@Tag(name = "{Domain}", description = "{Domain} API")
@Secured(SecurityRule.IS_AUTHENTICATED)
class {Domain}Controller(
  private val {domain}Manager: {Domain}Manager
) {

  @Get("/{domain}s")
  suspend fun list(
    @QueryValue page: Int?,
    @QueryValue limit: Int?,
    @QueryValue status: String?
  ): {Domain}ListResponse {
    return {domain}Manager.list(
      page = page ?: 1,
      limit = limit ?: 20,
      status = status
    ).throwOrValue()
  }

  @Get("/{domain}")
  suspend fun getById(
    @QueryValue id: UUID
  ): {Domain}Response {
    return {domain}Manager.byId(id).throwOrValue()
  }

  @Post("/{domain}")
  suspend fun create(
    @Valid @Body request: Create{Domain}Request
  ): {Domain}Response {
    return {domain}Manager.create(request).throwOrValue()
  }

  @Post("/{domain}/update")
  suspend fun update(
    @QueryValue id: UUID,
    @Valid @Body request: Update{Domain}Request
  ): {Domain}Response {
    return {domain}Manager.update(id, request).throwOrValue()
  }

  @Post("/{domain}/delete")
  suspend fun delete(
    @QueryValue id: UUID
  ): Boolean {
    return {domain}Manager.deleteById(id).throwOrValue()
  }
}
```

**Key Points**:
- `@ExecuteOn(TaskExecutors.IO)` required for suspend functions
- Query params for ALL identifiers (`@QueryValue id: UUID`)
- Thin methods - just delegate to manager
- `.throwOrValue()` to unwrap Either
- Inject Manager only (never Repository)
- NO inline data classes

### 3. Create Manager Interface

Location: `app/module-{domain}/module-api/src/main/kotlin/com/yourcompany/{domain}/contract/{Domain}Manager.kt`

```kotlin
package com.yourcompany.{domain}.contract

import arrow.core.Either
import com.yourcompany.client.request.{domain}.Create{Domain}Request
import com.yourcompany.client.request.{domain}.Update{Domain}Request
import com.yourcompany.client.response.{domain}.{Domain}Response
import com.yourcompany.client.response.{domain}.{Domain}ListResponse
import com.yourcompany.exception.ClientException
import java.util.UUID

interface {Domain}Manager {
  suspend fun list(
    page: Int,
    limit: Int,
    status: String?
  ): Either<ClientException, {Domain}ListResponse>

  suspend fun byId(id: UUID): Either<ClientException, {Domain}Response>

  suspend fun create(
    request: Create{Domain}Request
  ): Either<ClientException, {Domain}Response>

  suspend fun update(
    id: UUID,
    request: Update{Domain}Request
  ): Either<ClientException, {Domain}Response>

  suspend fun deleteById(id: UUID): Either<ClientException, Boolean>
}
```

### 4. Create Manager Implementation

Location: `app/module-{domain}/module-impl/src/main/kotlin/com/yourcompany/{domain}/impl/Default{Domain}Manager.kt`

```kotlin
package com.yourcompany.{domain}.impl

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import com.yourcompany.database.DatabaseContext
import com.yourcompany.{domain}.contract.{Domain}Manager
import com.yourcompany.client.request.{domain}.Create{Domain}Request
import com.yourcompany.client.request.{domain}.Update{Domain}Request
import com.yourcompany.client.response.{domain}.{Domain}Response
import com.yourcompany.client.response.{domain}.{Domain}ListResponse
import com.yourcompany.exception.ClientError
import com.yourcompany.exception.ClientException
import com.yourcompany.postgresql.entity.{Domain}Entity
import com.yourcompany.postgresql.repository.{Domain}Repository
import org.jetbrains.exposed.sql.transactions.transaction
import java.util.UUID

class Default{Domain}Manager(
  private val {domain}Repository: {Domain}Repository,
  private val db: DatabaseContext
) : {Domain}Manager {

  override suspend fun byId(id: UUID): Either<ClientException, {Domain}Response> {
    val entity = {domain}Repository.byId(id)
      ?: return ClientError.{DOMAIN}_NOT_FOUND.asException().left()

    return {Domain}Response.from(entity).right()
  }

  override suspend fun create(
    request: Create{Domain}Request
  ): Either<ClientException, {Domain}Response> {
    val entity = {Domain}Entity(
      name = request.name,
      description = request.description
    )

    val inserted = transaction(db.primary) {
      {domain}Repository.insert(entity)
    }

    return {Domain}Response.from(inserted).right()
  }

  override suspend fun update(
    id: UUID,
    request: Update{Domain}Request
  ): Either<ClientException, {Domain}Response> {
    val existing = {domain}Repository.byId(id)
      ?: return ClientError.{DOMAIN}_NOT_FOUND.asException().left()

    val updated = transaction(db.primary) {
      {domain}Repository.update(
        id = id,
        name = request.name,
        description = request.description,
        status = request.status
      )
    } ?: return ClientError.{DOMAIN}_NOT_FOUND.asException().left()

    return {Domain}Response.from(updated).right()
  }

  override suspend fun deleteById(id: UUID): Either<ClientException, Boolean> {
    val deleted = transaction(db.primary) {
      {domain}Repository.deleteById(id)
    }

    return if (deleted != null) {
      true.right()
    } else {
      ClientError.{DOMAIN}_NOT_FOUND.asException().left()
    }
  }
}
```

**Key Points**:
- Use `{Domain}Response.from(entity)` for conversions (companion object pattern)
- `transaction(db.primary)` for writes
- Return `Either.left()` for errors, `Either.right()` for success
- NO `!!` operators

### 5. Register Factory Bean

Location: `app/module-{domain}/module-impl/src/main/kotlin/com/yourcompany/runtime/factory/{Domain}ManagerFactory.kt`

```kotlin
package com.yourcompany.runtime.factory

import com.yourcompany.database.DatabaseContext
import com.yourcompany.{domain}.impl.Default{Domain}Manager
import com.yourcompany.{domain}.contract.{Domain}Manager
import com.yourcompany.postgresql.repository.{Domain}Repository
import io.micronaut.context.annotation.Factory
import jakarta.inject.Singleton

@Factory
class {Domain}ManagerFactory {

  @Singleton
  fun provide{Domain}Manager(
    {domain}Repository: {Domain}Repository,
    db: DatabaseContext
  ): {Domain}Manager {
    return Default{Domain}Manager({domain}Repository, db)
  }
}
```

### 6. Create Retrofit Client

Location: `app/module-client/src/main/kotlin/com/yourcompany/client/{Domain}Client.kt`

```kotlin
package com.yourcompany.client

import com.yourcompany.client.request.{domain}.Create{Domain}Request
import com.yourcompany.client.request.{domain}.Update{Domain}Request
import com.yourcompany.client.response.{domain}.{Domain}Response
import com.yourcompany.client.response.{domain}.{Domain}ListResponse
import retrofit2.http.*
import java.util.UUID

interface {Domain}Client {

  @GET("/api/v1/{domain}s")
  suspend fun list(
    @Header("Authorization") authorization: String,
    @Query("page") page: Int? = null,
    @Query("limit") limit: Int? = null,
    @Query("status") status: String? = null
  ): {Domain}ListResponse

  @GET("/api/v1/{domain}")
  suspend fun getById(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID
  ): {Domain}Response

  @POST("/api/v1/{domain}")
  suspend fun create(
    @Header("Authorization") authorization: String,
    @Body request: Create{Domain}Request
  ): {Domain}Response

  @POST("/api/v1/{domain}/update")
  suspend fun update(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID,
    @Body request: Update{Domain}Request
  ): {Domain}Response

  @POST("/api/v1/{domain}/delete")
  suspend fun delete(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID
  ): Boolean
}
```

### 7. Create Integration Test

Location: `app/api-application/src/test/kotlin/com/yourcompany/{Domain}ControllerTest.kt`

> See `testing-patterns.md` for complete test examples.

### 8. Run Tests

```bash
./gradlew :app:api-application:test --tests "{Domain}ControllerTest"
./gradlew test
```

## Interaction Style

- Always generates the full stack: models, controller, manager, factory, client, tests
- Follows the project's exact patterns — no shortcuts or creative alternatives
- Uses query parameters for all IDs, never path parameters
- Asks which domain entity before starting if not clear from context

## Rules

### RPC-Style API (POST for Mutations, Query Params Only)

This project uses **RPC-style endpoints: @Get for reads, @Post for all mutations, query parameters for all IDs**:

```
GET  /api/v1/employees              # List employees (plural)
GET  /api/v1/employee               # Get one employee (?id=xxx)
POST /api/v1/employee               # Create employee
POST /api/v1/employee/update        # Update employee
POST /api/v1/employee/delete        # Delete employee (soft)
```

**Rules from API_RULES.md:**
- NEVER use path parameters (`/{id}`)
- Use query parameters: `@QueryValue id: UUID`
- Singular nouns for single resource, plural for collections
- Use verb sub-paths for actions (`/delete`, `/restore`)

### Layered Architecture

```
HTTP Request → Controller → Manager → Repository → Database
```

**Controller**: Thin (just delegation), HTTP annotations, @ExecuteOn(TaskExecutors.IO), @Secured, unwrap Either with `.throwOrValue()`

**Manager**: All business logic, returns `Either<ClientException, T>`, wraps DB operations in transactions, never throws exceptions

**Repository**: Data access only (already exists)

### NO !! Operator

```kotlin
val employee = employeeRepository.byId(id)
  ?: return ClientError.EMPLOYEE_NOT_FOUND.asException().left()
```

### Error Handling Patterns

#### Not Found
```kotlin
val entity = repository.byId(id)
  ?: return ClientError.{DOMAIN}_NOT_FOUND.asException().left()
```

#### Already Exists
```kotlin
val existing = repository.byEmail(email)
if (existing != null) {
  return ClientError.EMAIL_ALREADY_IN_USE.asException().left()
}
```

## Output

- Controller is thin (just delegation)
- Controller has `@ExecuteOn(TaskExecutors.IO)`
- NO path parameters (use `@QueryValue` for all IDs)
- Manager returns Either (never throws)
- Transactions wrap DB operations
- No `!!` operator
- Response models in module-client with `companion object { fun from() }`
- NO inline data classes in controllers
- Integration tests use Retrofit client
- All tests pass
