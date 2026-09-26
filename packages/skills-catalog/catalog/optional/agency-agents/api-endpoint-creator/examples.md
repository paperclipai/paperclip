# API Endpoint Creator - Code Examples

This file has real patterns from the codebase. **Follow these patterns exactly**.

---

## Complete Example: Project Management Endpoint

Shows the full flow from Controller → Manager → Repository.

### 1. Controller Layer

**File**: `app/api-application/src/main/kotlin/com/yourcompany/controller/admin/ProjectController.kt`

```kotlin
package com.yourcompany.controller.admin

import com.yourcompany.auth.contract.model.UserAuthentication
import com.yourcompany.client.request.{domain}.CreateProjectRequest
import com.yourcompany.client.request.{domain}.UpdateProjectRequest
import com.yourcompany.client.response.{domain}.ProjectResponse
import com.yourcompany.client.response.{domain}.ProjectListResponse
import com.yourcompany.exception.throwOrValue
import com.yourcompany.{domain}.contract.ProjectManager
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
@Controller("/api/v1/admin")
@Tag(name = "Projects", description = "Project management API")
@Secured(OAuthSecurityRule.ADMIN)
class ProjectController(
  private val projectManager: ProjectManager
) {

  @Get("/projects")
  suspend fun listProjects(
    @QueryValue page: Int?,
    @QueryValue limit: Int?,
    @QueryValue status: String?
  ): ProjectListResponse {
    return projectManager.list(
      page = page ?: 1,
      limit = limit ?: 20,
      status = status
    ).throwOrValue()
  }

  @Get("/project")
  suspend fun getProject(
    @QueryValue id: UUID
  ): ProjectResponse {
    return projectManager.byId(id).throwOrValue()
  }

  @Post("/project")
  suspend fun createProject(
    @Valid @Body request: CreateProjectRequest
  ): ProjectResponse {
    return projectManager.create(request).throwOrValue()
  }

  @Post("/project/update")
  suspend fun updateProject(
    @QueryValue id: UUID,
    @Valid @Body request: UpdateProjectRequest
  ): ProjectResponse {
    return projectManager.update(id, request).throwOrValue()
  }

  @Post("/project/delete")
  suspend fun deleteProject(
    @QueryValue id: UUID
  ): Boolean {
    return projectManager.deleteById(id).throwOrValue()
  }
}
```

**Controller Pattern Key Points**:
- `@ExecuteOn(TaskExecutors.IO)` for suspend function support
- `@Controller` defines base path
- `@Secured(OAuthSecurityRule.ADMIN)` for admin-only access
- All IDs as `@QueryValue` (never path params)
- Methods are `suspend` for coroutines
- **Thin controllers**: Only delegate to manager
- Use `.throwOrValue()` to unwrap `Either`
- NO inline data classes

---

### 2. Manager Interface

**File**: `app/module-{domain}/module-api/src/main/kotlin/com/yourcompany/insight/contract/ProjectManager.kt`

```kotlin
package com.yourcompany.{domain}.contract

import arrow.core.Either
import com.yourcompany.client.request.{domain}.CreateProjectRequest
import com.yourcompany.client.request.{domain}.UpdateProjectRequest
import com.yourcompany.client.response.{domain}.ProjectResponse
import com.yourcompany.client.response.{domain}.ProjectListResponse
import com.yourcompany.exception.ClientException
import java.util.UUID

interface ProjectManager {
  suspend fun list(
    page: Int,
    limit: Int,
    status: String?
  ): Either<ClientException, ProjectListResponse>

  suspend fun byId(id: UUID): Either<ClientException, ProjectResponse>

  suspend fun create(
    request: CreateProjectRequest
  ): Either<ClientException, ProjectResponse>

  suspend fun update(
    id: UUID,
    request: UpdateProjectRequest
  ): Either<ClientException, ProjectResponse>

  suspend fun deleteById(id: UUID): Either<ClientException, Boolean>
}
```

**Manager Interface Key Points**:
- All methods return `Either<ClientException, T>`
- Use `suspend` for async operations
- No implementation details

---

### 3. Manager Implementation

**File**: `app/module-{domain}/module-impl/src/main/kotlin/com/yourcompany/insight/impl/DefaultProjectManager.kt`

```kotlin
package com.yourcompany.{domain}.impl

import arrow.core.Either
import arrow.core.left
import arrow.core.right
import com.yourcompany.database.DatabaseContext
import com.yourcompany.client.request.{domain}.CreateProjectRequest
import com.yourcompany.client.request.{domain}.UpdateProjectRequest
import com.yourcompany.client.response.{domain}.ProjectResponse
import com.yourcompany.client.response.{domain}.ProjectListResponse
import com.yourcompany.exception.ClientError
import com.yourcompany.exception.ClientException
import com.yourcompany.{domain}.contract.ProjectManager
import com.yourcompany.postgresql.entity.ProjectEntity
import com.yourcompany.postgresql.repository.ProjectRepository
import com.yourcompany.postgresql.repository.EmployeeRepository
import org.jetbrains.exposed.sql.transactions.transaction
import java.util.UUID

class DefaultProjectManager(
  private val db: DatabaseContext,
  private val projectRepository: ProjectRepository,
  private val employeeRepository: EmployeeRepository
) : ProjectManager {

  override suspend fun byId(id: UUID): Either<ClientException, ProjectResponse> {
    val entity = projectRepository.byId(id)
      ?: return ClientError.PROJECT_NOT_FOUND.asException().left()

    val ownerName = entity.ownerEmployeeId?.let {
      employeeRepository.byId(it)?.name
    }

    return ProjectResponse.from(entity, ownerName).right()
  }

  override suspend fun create(
    request: CreateProjectRequest
  ): Either<ClientException, ProjectResponse> {
    val entity = ProjectEntity(
      name = request.name,
      description = request.description,
      ownerEmployeeId = request.ownerEmployeeId,
      githubOrg = request.githubOrg
    )

    val inserted = transaction(db.primary) {
      projectRepository.insert(entity)
    }

    return ProjectResponse.from(inserted, ownerName = null).right()
  }

  override suspend fun update(
    id: UUID,
    request: UpdateProjectRequest
  ): Either<ClientException, ProjectResponse> {
    projectRepository.byId(id)
      ?: return ClientError.PROJECT_NOT_FOUND.asException().left()

    val updated = transaction(db.primary) {
      projectRepository.update(
        id = id,
        name = request.name,
        description = request.description,
        ownerEmployeeId = request.ownerEmployeeId,
        status = request.status,
        githubOrg = request.githubOrg
      )
    } ?: return ClientError.PROJECT_NOT_FOUND.asException().left()

    val ownerName = updated.ownerEmployeeId?.let {
      employeeRepository.byId(it)?.name
    }

    return ProjectResponse.from(updated, ownerName).right()
  }

  override suspend fun deleteById(id: UUID): Either<ClientException, Boolean> {
    val deleted = transaction(db.primary) {
      projectRepository.deleteById(id)
    }

    return if (deleted != null) {
      true.right()
    } else {
      ClientError.PROJECT_NOT_FOUND.asException().left()
    }
  }
}
```

---

### 4. Response Model with Companion Object

**File**: `app/module-client/src/main/kotlin/com/yourcompany/client/response/insight/ProjectResponse.kt`

```kotlin
package com.yourcompany.client.response.{domain}

import com.yourcompany.postgresql.entity.ProjectEntity
import java.time.Instant
import java.util.UUID

data class ProjectResponse(
  val id: UUID,
  val name: String,
  val description: String?,
  val ownerEmployeeId: UUID?,
  val ownerName: String?,
  val status: String,
  val githubOrg: String?,
  val createdAt: Instant,
  val updatedAt: Instant?
) {
  companion object {
    fun from(
      entity: ProjectEntity,
      ownerName: String?,
      contributorCount: Int = 0
    ): ProjectResponse = ProjectResponse(
      id = entity.id,
      name = entity.name,
      description = entity.description,
      ownerEmployeeId = entity.ownerEmployeeId,
      ownerName = ownerName,
      status = entity.status,
      githubOrg = entity.githubOrg,
      createdAt = entity.createdAt,
      updatedAt = entity.updatedAt
    )
  }
}

data class ProjectListResponse(
  val items: List<ProjectResponse>,
  val total: Int,
  val page: Int,
  val limit: Int,
  val hasMore: Boolean
)
```

**Response Model Key Points**:
- `companion object { fun from() }` for entity-to-response conversion
- Extra params for data not in the entity (ownerName, counts)
- Lives in `module-client/response/` directory

---

### 5. Request Model

**File**: `app/module-client/src/main/kotlin/com/yourcompany/client/request/insight/ProjectRequests.kt`

```kotlin
package com.yourcompany.client.request.{domain}

import java.util.UUID

data class CreateProjectRequest(
  val name: String,
  val description: String? = null,
  val ownerEmployeeId: UUID? = null,
  val githubOrg: String? = null
)

data class UpdateProjectRequest(
  val name: String? = null,
  val description: String? = null,
  val ownerEmployeeId: UUID? = null,
  val status: String? = null,
  val githubOrg: String? = null
)
```

---

### 6. Factory Bean

**File**: `app/module-{domain}/module-impl/src/main/kotlin/com/yourcompany/runtime/factory/{Domain}ManagerFactory.kt`

```kotlin
package com.yourcompany.runtime.factory

import com.yourcompany.database.DatabaseContext
import com.yourcompany.{domain}.contract.ProjectManager
import com.yourcompany.{domain}.impl.DefaultProjectManager
import com.yourcompany.postgresql.repository.ProjectRepository
import com.yourcompany.postgresql.repository.EmployeeRepository
import io.micronaut.context.annotation.Factory
import jakarta.inject.Singleton

@Factory
class {Domain}ManagerFactory {

  @Singleton
  fun provideProjectManager(
    db: DatabaseContext,
    projectRepository: ProjectRepository,
    employeeRepository: EmployeeRepository
  ): ProjectManager {
    return DefaultProjectManager(
      db = db,
      projectRepository = projectRepository,
      employeeRepository = employeeRepository
    )
  }
}
```

---

### 7. Retrofit Client

**File**: `app/module-client/src/main/kotlin/com/yourcompany/client/ProjectClient.kt`

```kotlin
package com.yourcompany.client

import com.yourcompany.client.request.{domain}.CreateProjectRequest
import com.yourcompany.client.request.{domain}.UpdateProjectRequest
import com.yourcompany.client.response.{domain}.ProjectResponse
import com.yourcompany.client.response.{domain}.ProjectListResponse
import retrofit2.http.*
import java.util.UUID

interface ProjectClient {

  @GET("/api/v1/admin/projects")
  suspend fun listProjects(
    @Header("Authorization") authorization: String,
    @Query("page") page: Int? = null,
    @Query("limit") limit: Int? = null,
    @Query("status") status: String? = null
  ): ProjectListResponse

  @GET("/api/v1/admin/project")
  suspend fun getProject(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID
  ): ProjectResponse

  @POST("/api/v1/admin/project")
  suspend fun createProject(
    @Header("Authorization") authorization: String,
    @Body request: CreateProjectRequest
  ): ProjectResponse

  @POST("/api/v1/admin/project/update")
  suspend fun updateProject(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID,
    @Body request: UpdateProjectRequest
  ): ProjectResponse

  @POST("/api/v1/admin/project/delete")
  suspend fun deleteProject(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID
  ): Boolean
}
```

---

## Error Handling Patterns

### Pattern 1: Not Found
```kotlin
val entity = repository.byId(id)
  ?: return ClientError.PROJECT_NOT_FOUND.asException().left()
return ProjectResponse.from(entity, ownerName).right()
```

### Pattern 2: Already Exists
```kotlin
val existing = repository.byEmail(email)
if (existing != null) {
  return ClientError.EMAIL_ALREADY_IN_USE.asException().left()
}
```

### Pattern 3: Multiple Validations
```kotlin
val existing = repository.byId(id)
  ?: return ClientError.NOT_FOUND.asException().left()

if (existing.ownerId != currentUserId) {
  return ClientError.UNAUTHORIZED.asException().left()
}
```

---

## Anti-Patterns to AVOID

**Wrong: Business logic in controller**
```kotlin
@Post("/project")
suspend fun create(@Valid @Body request: CreateProjectRequest): ProjectResponse {
  if (request.name.isBlank()) { throw BadRequestException("Name required") }
  val entity = repository.insert(...)
  return ProjectResponse.from(entity)
}
```

**Correct: Thin controller**
```kotlin
@Post("/project")
suspend fun create(@Valid @Body request: CreateProjectRequest): ProjectResponse {
  return projectManager.create(request).throwOrValue()
}
```

---

**Wrong: Path parameters**
```kotlin
@Get("/project/{id}")
suspend fun getProject(@PathVariable id: UUID): ProjectResponse
```

**Correct: Query parameters**
```kotlin
@Get("/project")
suspend fun getProject(@QueryValue id: UUID): ProjectResponse
```

---

**Wrong: Manager throws exceptions**
```kotlin
override suspend fun byId(id: UUID): ProjectResponse {
  val entity = repository.byId(id)
    ?: throw NotFoundException("Project not found")
  return ProjectResponse.from(entity)
}
```

**Correct: Manager returns Either**
```kotlin
override suspend fun byId(id: UUID): Either<ClientException, ProjectResponse> {
  val entity = repository.byId(id)
    ?: return ClientError.PROJECT_NOT_FOUND.asException().left()
  return ProjectResponse.from(entity, ownerName).right()
}
```

---

## Summary Checklist

**Controller**:
- [ ] Has `@ExecuteOn(TaskExecutors.IO)`
- [ ] Has `@Secured(...)`
- [ ] Uses `@QueryValue` for IDs (no path params)
- [ ] Methods are `suspend`
- [ ] Only delegates to manager
- [ ] Uses `.throwOrValue()`
- [ ] NO inline data classes

**Manager**:
- [ ] Returns `Either<ClientException, T>`
- [ ] Uses `ClientError.{NAME}.asException().left()` for errors
- [ ] Uses `.right()` for success
- [ ] NO `!!` operators
- [ ] Converts entities using `Response.from(entity)`

**Models**:
- [ ] Response models in `module-client/response/`
- [ ] Request models in `module-client/request/`
- [ ] Response has `companion object { fun from() }`

**Follow these patterns exactly for consistent code.**
